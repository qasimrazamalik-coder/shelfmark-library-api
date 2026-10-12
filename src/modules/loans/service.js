const config = require('../../config');
const { audit } = require('../../db');
const { isStaff } = require('../../middleware/auth');
const { notFound, conflict, forbidden, badRequest } = require('../../errors');
const { routeFreedCopy } = require('../holds/queue');

const P = config.policy;

/**
 * A member's current standing: everything that decides whether they may
 * borrow. Pass a transaction client to read it consistently while locked.
 */
async function getStanding(db, memberId) {
  const { rows: [s] } = await db.query(
    `SELECT
       (SELECT count(*) FROM loans WHERE member_id = $1 AND returned_at IS NULL) AS active_loans,
       (SELECT count(*) FROM loans WHERE member_id = $1 AND returned_at IS NULL AND due_at < now()) AS overdue_loans,
       (SELECT coalesce(sum(amount_cents), 0) FROM fines
         WHERE member_id = $1 AND paid_at IS NULL AND waived_at IS NULL) AS unpaid_cents`,
    [memberId]
  );
  const blockers = [];
  if (s.active_loans >= P.maxActiveLoans) blockers.push('LOAN_LIMIT');
  if (s.overdue_loans > 0) blockers.push('HAS_OVERDUE');
  if (s.unpaid_cents >= P.blockAtFinesCents) blockers.push('FINES_OWED');
  return {
    activeLoans: s.active_loans,
    maxLoans: P.maxActiveLoans,
    overdueLoans: s.overdue_loans,
    unpaidCents: s.unpaid_cents,
    blockAtCents: P.blockAtFinesCents,
    canBorrow: blockers.length === 0,
    blockers,
  };
}

const blockerMessages = {
  LOAN_LIMIT: `Members can have at most ${P.maxActiveLoans} books out at once. Return one first.`,
  HAS_OVERDUE: 'Return your overdue books before borrowing more.',
  FINES_OWED: `Unpaid fines have reached the limit. Settle them at the desk to keep borrowing.`,
};

async function lockMember(client, memberId) {
  // Locking the member row serialises concurrent checkouts for the same
  // person, so two simultaneous requests cannot both slip under the loan limit.
  const { rows: [m] } = await client.query('SELECT id, name, role FROM users WHERE id = $1 FOR UPDATE', [memberId]);
  if (!m) throw notFound('Member');
  return m;
}

/** Picks and locks the physical copy to lend, honouring the hold shelf. */
async function pickCopy(client, memberId, { bookId, barcode }) {
  if (barcode) {
    const { rows: [copy] } = await client.query('SELECT * FROM copies WHERE barcode = $1 FOR UPDATE', [barcode]);
    if (!copy) throw notFound('Copy with that barcode');
    if (copy.status === 'available') return { copy, hold: null };
    if (copy.status === 'on_hold_shelf') {
      const { rows: [hold] } = await client.query(
        `SELECT * FROM holds WHERE copy_id = $1 AND status = 'ready' FOR UPDATE`, [copy.id]);
      if (hold && hold.member_id === memberId) return { copy, hold };
      throw conflict('RESERVED_FOR_ANOTHER', 'This copy is on the hold shelf for another member.');
    }
    if (copy.status === 'on_loan') throw conflict('COPY_ALREADY_ON_LOAN', 'That copy is already on loan.');
    throw conflict('COPY_NOT_LOANABLE', `That copy is marked ${copy.status} and cannot be lent.`);
  }

  // Self-service by title: a ready hold for this member wins first.
  const { rows: [hold] } = await client.query(
    `SELECT * FROM holds WHERE book_id = $1 AND member_id = $2 AND status = 'ready' FOR UPDATE`,
    [bookId, memberId]
  );
  if (hold) {
    const { rows: [copy] } = await client.query('SELECT * FROM copies WHERE id = $1 FOR UPDATE', [hold.copy_id]);
    return { copy, hold };
  }

  // SKIP LOCKED: concurrent borrowers of the same title get different copies
  // instead of queueing behind each other on the first row.
  const { rows: [copy] } = await client.query(
    `SELECT * FROM copies WHERE book_id = $1 AND status = 'available'
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [bookId]
  );
  if (!copy) {
    const { rows: [b] } = await client.query('SELECT id FROM books WHERE id = $1', [bookId]);
    if (!b) throw notFound('Book');
    throw conflict('NO_COPY_AVAILABLE', 'Every copy is out right now. Place a hold to join the queue.');
  }
  return { copy, hold: null };
}

async function checkout(client, actor, input) {
  if (input.memberId && input.memberId !== actor.id && !isStaff(actor)) throw forbidden();
  if (!input.bookId && !input.barcode) throw badRequest('VALIDATION_FAILED', 'Give a bookId or a barcode.');
  const memberId = input.memberId ?? actor.id;

  await lockMember(client, memberId);
  const standing = await getStanding(client, memberId);
  if (!standing.canBorrow) {
    const code = standing.blockers[0];
    throw conflict(code, blockerMessages[code], { standing });
  }

  const { copy, hold } = await pickCopy(client, memberId, input);

  const { rows: [dup] } = await client.query(
    `SELECT 1 FROM loans l JOIN copies c ON c.id = l.copy_id
      WHERE l.member_id = $1 AND l.returned_at IS NULL AND c.book_id = $2`,
    [memberId, copy.book_id]
  );
  if (dup) throw conflict('ALREADY_BORROWED', 'You already have a copy of this title.');

  const { rows: [loan] } = await client.query(
    `INSERT INTO loans (copy_id, member_id, due_at)
     VALUES ($1, $2, now() + make_interval(days => $3)) RETURNING *`,
    [copy.id, memberId, P.loanDays]
  );
  await client.query(`UPDATE copies SET status = 'on_loan' WHERE id = $1`, [copy.id]);

  // Close out the member's hold on this title (ready or still waiting).
  await client.query(
    `UPDATE holds SET status = 'fulfilled', closed_at = now()
      WHERE book_id = $1 AND member_id = $2 AND status IN ('waiting', 'ready')`,
    [copy.book_id, memberId]
  );

  await audit(client, actor.id, 'loan.checkout', 'loan', loan.id, {
    memberId, copyId: copy.id, barcode: copy.barcode, viaHold: hold?.id ?? null,
  });
  return loanView(client, loan.id);
}

async function returnCopy(client, actor, { barcode, loanId }) {
  const { rows: [loan] } = await client.query(
    `SELECT l.* FROM loans l JOIN copies c ON c.id = l.copy_id
      WHERE l.returned_at IS NULL AND (c.barcode = $1 OR l.id = $2)
      FOR UPDATE OF l`,
    [barcode ?? null, loanId ?? null]
  );
  if (!loan) throw notFound('Open loan for that copy');

  // Fine is computed by the database from its own clock, in whole started days,
  // capped at the replacement cost of the book.
  const { rows: [closed] } = await client.query(
    `UPDATE loans SET returned_at = now() WHERE id = $1
     RETURNING *, greatest(0, ceil(extract(epoch FROM (returned_at - due_at)) / 86400))::int AS days_late`,
    [loan.id]
  );

  let fine = null;
  if (closed.days_late > 0) {
    const { rows: [f] } = await client.query(
      `INSERT INTO fines (loan_id, member_id, amount_cents, reason)
       SELECT $1, $2, least($3::int * $4::int, b.replacement_cents), $5
         FROM copies c JOIN books b ON b.id = c.book_id
        WHERE c.id = $6 AND least($3::int * $4::int, b.replacement_cents) > 0
       RETURNING *`,
      [loan.id, loan.member_id, closed.days_late, P.finePerDayCents,
        `Returned ${closed.days_late} day${closed.days_late === 1 ? '' : 's'} late`, loan.copy_id]
    );
    fine = f ? { id: f.id, amountCents: f.amount_cents, reason: f.reason } : null;
  }

  const hold = await routeFreedCopy(client, loan.copy_id, actor.id);
  let heldFor = null;
  if (hold) {
    const { rows: [m] } = await client.query('SELECT name FROM users WHERE id = $1', [hold.member_id]);
    heldFor = { holdId: hold.id, memberName: m.name, pickupBy: hold.expires_at };
  }

  await audit(client, actor.id, 'loan.return', 'loan', loan.id, { daysLate: closed.days_late, fineId: fine?.id ?? null });
  return { loan: await loanView(client, loan.id), daysLate: closed.days_late, fine, heldFor };
}

async function lockLoanFor(client, actor, loanId) {
  const { rows: [loan] } = await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loanId]);
  // Members see a 404 for other people's loans, so ids can't be probed.
  if (!loan || (loan.member_id !== actor.id && !isStaff(actor))) throw notFound('Loan');
  if (loan.returned_at) throw conflict('LOAN_CLOSED', 'This loan has already been returned.');
  return loan;
}

async function renew(client, actor, loanId) {
  const loan = await lockLoanFor(client, actor, loanId);
  if (new Date(loan.due_at) < new Date()) {
    throw conflict('OVERDUE', 'Overdue books cannot be renewed. Bring it back to the desk.');
  }
  if (loan.renewals >= P.maxRenewals) {
    throw conflict('RENEWAL_LIMIT', `A loan can be renewed ${P.maxRenewals} times. This one has reached the limit.`);
  }
  const { rows: [waiting] } = await client.query(
    `SELECT count(*) AS n FROM holds h JOIN copies c ON c.book_id = h.book_id
      WHERE c.id = $1 AND h.status = 'waiting'`,
    [loan.copy_id]
  );
  if (waiting.n > 0) {
    throw conflict('TITLE_ON_HOLD', 'Someone is waiting for this title, so it cannot be renewed.');
  }
  const standing = await getStanding(client, loan.member_id);
  if (standing.blockers.includes('FINES_OWED')) throw conflict('FINES_OWED', blockerMessages.FINES_OWED);

  await client.query(
    `UPDATE loans SET due_at = due_at + make_interval(days => $2), renewals = renewals + 1 WHERE id = $1`,
    [loan.id, P.loanDays]
  );
  await audit(client, actor.id, 'loan.renew', 'loan', loan.id, { renewal: loan.renewals + 1 });
  return loanView(client, loan.id);
}

/** Staff action: the member lost the book. Closes the loan and charges replacement cost. */
async function declareLost(client, actor, loanId) {
  const loan = await lockLoanFor(client, actor, loanId);
  await client.query('UPDATE loans SET returned_at = now() WHERE id = $1', [loan.id]);
  await client.query(`UPDATE copies SET status = 'lost' WHERE id = $1`, [loan.copy_id]);
  const { rows: [f] } = await client.query(
    `INSERT INTO fines (loan_id, member_id, amount_cents, reason)
     SELECT $1, $2, b.replacement_cents, 'Lost item: replacement cost'
       FROM copies c JOIN books b ON b.id = c.book_id
      WHERE c.id = $3 AND b.replacement_cents > 0
     RETURNING *`,
    [loan.id, loan.member_id, loan.copy_id]
  );
  await audit(client, actor.id, 'loan.lost', 'loan', loan.id, { fineId: f?.id ?? null });
  return { loan: await loanView(client, loan.id), fine: f ? { id: f.id, amountCents: f.amount_cents } : null };
}

// One SQL shape for every loan the API returns, including live fine accrual.
const LOAN_SELECT = `
  SELECT l.id, l.member_id AS "memberId", u.name AS "memberName",
         l.loaned_at AS "loanedAt", l.due_at AS "dueAt", l.returned_at AS "returnedAt",
         l.renewals, c.barcode, b.id AS "bookId", b.title, b.author,
         CASE WHEN l.returned_at IS NULL AND l.due_at < now()
              THEN ceil(extract(epoch FROM (now() - l.due_at)) / 86400)::int ELSE 0 END AS "daysOverdue",
         CASE WHEN l.returned_at IS NULL AND l.due_at < now()
              THEN least(ceil(extract(epoch FROM (now() - l.due_at)) / 86400)::int * ${Number(P.finePerDayCents)},
                         b.replacement_cents)
              ELSE 0 END AS "accruingCents",
         (SELECT count(*) FROM holds h WHERE h.book_id = b.id AND h.status = 'waiting')::int AS "queueLength"
    FROM loans l
    JOIN copies c ON c.id = l.copy_id
    JOIN books b  ON b.id = c.book_id
    JOIN users u  ON u.id = l.member_id`;

function decorate(row) {
  const reasons = [];
  if (row.returnedAt) reasons.push('LOAN_CLOSED');
  else {
    if (row.daysOverdue > 0) reasons.push('OVERDUE');
    if (row.renewals >= P.maxRenewals) reasons.push('RENEWAL_LIMIT');
    if (row.queueLength > 0) reasons.push('TITLE_ON_HOLD');
  }
  return { ...row, renewalsLeft: Math.max(0, P.maxRenewals - row.renewals), canRenew: reasons.length === 0, renewBlockers: reasons };
}

async function loanView(db, loanId) {
  const { rows: [row] } = await db.query(`${LOAN_SELECT} WHERE l.id = $1`, [loanId]);
  return decorate(row);
}

async function listLoans(db, { memberId, open, overdueOnly, limit = 50 }) {
  const { rows } = await db.query(
    `${LOAN_SELECT}
      WHERE ($1::bigint IS NULL OR l.member_id = $1)
        AND ($2::boolean IS NULL OR (l.returned_at IS NULL) = $2)
        AND ($3::boolean IS NOT TRUE OR (l.returned_at IS NULL AND l.due_at < now()))
      ORDER BY l.returned_at IS NULL DESC, l.due_at
      LIMIT $4`,
    [memberId ?? null, open ?? null, overdueOnly ?? null, limit]
  );
  return rows.map(decorate);
}

module.exports = { getStanding, checkout, returnCopy, renew, declareLost, listLoans, loanView };
