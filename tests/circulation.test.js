const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, reset, makeUser, makeBook, backdateLoan, query, close } = require('./helpers');

let librarian, admin;

before(async () => {
  await reset();
  librarian = await makeUser('librarian');
  admin = await makeUser('admin');
});
after(close);

const borrow = (user, body) => api().post('/api/loans').set(user.auth).send(body);
const giveBack = (barcode) => api().post('/api/loans/return').set(librarian.auth).send({ barcode });

describe('borrowing', () => {
  test('a member borrows a title and the copy leaves the shelf', async () => {
    const m = await makeUser();
    const book = await makeBook({ copies: 1 });
    const res = await borrow(m, { bookId: book.id });
    assert.equal(res.status, 201);
    assert.equal(res.body.barcode, book.barcodes[0]);
    const days = (new Date(res.body.dueAt) - new Date(res.body.loanedAt)) / 86400000;
    assert.equal(Math.round(days), 14);
    const detail = await api().get(`/api/books/${book.id}`);
    assert.equal(detail.body.availableCopies, 0);
    assert.equal(detail.body.copies[0].status, 'on_loan');
  });

  test('cannot borrow a second copy of the same title', async () => {
    const m = await makeUser();
    const book = await makeBook({ copies: 2 });
    await borrow(m, { bookId: book.id });
    const res = await borrow(m, { bookId: book.id });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ALREADY_BORROWED');
  });

  test('loan limit is enforced', async () => {
    const m = await makeUser();
    for (let i = 0; i < 5; i++) {
      const b = await makeBook();
      assert.equal((await borrow(m, { bookId: b.id })).status, 201);
    }
    const sixth = await borrow(m, { bookId: (await makeBook()).id });
    assert.equal(sixth.status, 409);
    assert.equal(sixth.body.error.code, 'LOAN_LIMIT');
    assert.equal(sixth.body.error.details.standing.activeLoans, 5);
  });

  test('RACE: eight simultaneous borrows by one member still stop at the limit of five', async () => {
    const m = await makeUser();
    const titles = await Promise.all(Array.from({ length: 8 }, () => makeBook()));
    const results = await Promise.all(titles.map((b) => borrow(m, { bookId: b.id })));
    const ok = results.filter((r) => r.status === 201).length;
    assert.equal(ok, 5);
    const { rows: [n] } = await query('SELECT count(*) AS n FROM loans WHERE member_id = $1 AND returned_at IS NULL', [m.id]);
    assert.equal(n.n, 5);
  });

  test('RACE: ten members grab the last copy at once, exactly one gets it', async () => {
    const book = await makeBook({ copies: 1 });
    const members = await Promise.all(Array.from({ length: 10 }, () => makeUser()));
    const results = await Promise.all(members.map((m) => borrow(m, { bookId: book.id })));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'NO_COPY_AVAILABLE'));
  });

  test('RACE: two copies, many borrowers, both copies lent to different people', async () => {
    const book = await makeBook({ copies: 2 });
    const members = await Promise.all(Array.from({ length: 6 }, () => makeUser()));
    const results = await Promise.all(members.map((m) => borrow(m, { bookId: book.id })));
    const winners = results.filter((r) => r.status === 201);
    assert.equal(winners.length, 2);
    assert.notEqual(winners[0].body.barcode, winners[1].body.barcode);
  });

  test('members cannot check out on behalf of someone else', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const book = await makeBook();
    const res = await borrow(a, { bookId: book.id, memberId: b.id });
    assert.equal(res.status, 403);
  });

  test('librarian checks out by barcode and library card at the desk', async () => {
    const m = await makeUser();
    const book = await makeBook({ copies: 2 });
    const res = await borrow(librarian, { barcode: book.barcodes[1], memberCard: m.card_number });
    assert.equal(res.status, 201);
    assert.equal(res.body.memberId, m.id);
    assert.equal(res.body.barcode, book.barcodes[1]);
  });
});

describe('returns and fines', () => {
  test('on-time return creates no fine and frees the copy', async () => {
    const m = await makeUser();
    const book = await makeBook();
    await borrow(m, { bookId: book.id });
    const res = await giveBack(book.barcodes[0]);
    assert.equal(res.status, 200);
    assert.equal(res.body.daysLate, 0);
    assert.equal(res.body.fine, null);
    assert.equal((await api().get(`/api/books/${book.id}`)).body.availableCopies, 1);
  });

  test('late return charges 25 cents per started day', async () => {
    const m = await makeUser();
    const book = await makeBook();
    const loan = await borrow(m, { bookId: book.id });
    await backdateLoan(loan.body.id, { dueDaysAgo: 6 });
    const res = await giveBack(book.barcodes[0]);
    assert.equal(res.body.daysLate, 7); // 6 days and a minute late = 7 started days
    assert.equal(res.body.fine.amountCents, 175);
  });

  test('fine is capped at the replacement cost', async () => {
    const m = await makeUser();
    const book = await makeBook({ replacementCents: 300 });
    const loan = await borrow(m, { bookId: book.id });
    await backdateLoan(loan.body.id, { dueDaysAgo: 100 });
    const res = await giveBack(book.barcodes[0]);
    assert.equal(res.body.fine.amountCents, 300);
  });

  test('returning a copy that is not on loan is a 404', async () => {
    const book = await makeBook();
    const res = await giveBack(book.barcodes[0]);
    assert.equal(res.status, 404);
  });

  test('overdue books and unpaid fines both block new borrowing', async () => {
    const m = await makeUser();
    const b1 = await makeBook();
    const loan = await borrow(m, { bookId: b1.id });
    await backdateLoan(loan.body.id, { dueDaysAgo: 2 });
    const blocked = await borrow(m, { bookId: (await makeBook()).id });
    assert.equal(blocked.body.error.code, 'HAS_OVERDUE');

    await backdateLoan(loan.body.id, { dueDaysAgo: 45 }); // 46 days x 25c = 11.50, over the 10.00 limit
    const ret = await giveBack(b1.barcodes[0]);
    assert.equal(ret.body.fine.amountCents, 1150);
    const stillBlocked = await borrow(m, { bookId: (await makeBook()).id });
    assert.equal(stillBlocked.body.error.code, 'FINES_OWED');

    const pay = await api().post(`/api/fines/${ret.body.fine.id}/pay`).set(librarian.auth);
    assert.equal(pay.body.status, 'paid');
    assert.equal((await borrow(m, { bookId: (await makeBook()).id })).status, 201);
  });

  test('a fine cannot be paid twice, and waiving needs an admin and a reason', async () => {
    const m = await makeUser();
    const book = await makeBook();
    const loan = await borrow(m, { bookId: book.id });
    await backdateLoan(loan.body.id, { dueDaysAgo: 1 });
    const { body } = await giveBack(book.barcodes[0]);

    const asLibrarian = await api().post(`/api/fines/${body.fine.id}/waive`).set(librarian.auth).send({ note: 'first offence' });
    assert.equal(asLibrarian.status, 403);
    const noNote = await api().post(`/api/fines/${body.fine.id}/waive`).set(admin.auth).send({});
    assert.equal(noNote.status, 400);
    const waived = await api().post(`/api/fines/${body.fine.id}/waive`).set(admin.auth).send({ note: 'first offence' });
    assert.equal(waived.body.status, 'waived');
    const again = await api().post(`/api/fines/${body.fine.id}/pay`).set(librarian.auth);
    assert.equal(again.body.error.code, 'FINE_SETTLED');
  });

  test('declaring a book lost closes the loan and charges replacement cost', async () => {
    const m = await makeUser();
    const book = await makeBook({ replacementCents: 4500 });
    const loan = await borrow(m, { bookId: book.id });
    const res = await api().post(`/api/loans/${loan.body.id}/lost`).set(librarian.auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.fine.amountCents, 4500);
    assert.ok(res.body.loan.returnedAt);
    const detail = await api().get(`/api/books/${book.id}`);
    assert.equal(detail.body.totalCopies, 0);
  });
});

describe('renewals', () => {
  test('renewing pushes the due date out by a loan period', async () => {
    const m = await makeUser();
    const book = await makeBook();
    const loan = await borrow(m, { bookId: book.id });
    const res = await api().post(`/api/loans/${loan.body.id}/renew`).set(m.auth);
    assert.equal(res.status, 200);
    const extra = (new Date(res.body.dueAt) - new Date(loan.body.dueAt)) / 86400000;
    assert.equal(Math.round(extra), 14);
    assert.equal(res.body.renewalsLeft, 1);
  });

  test('stops after two renewals', async () => {
    const m = await makeUser();
    const book = await makeBook();
    const loan = await borrow(m, { bookId: book.id });
    for (let i = 0; i < 2; i++) await api().post(`/api/loans/${loan.body.id}/renew`).set(m.auth);
    const res = await api().post(`/api/loans/${loan.body.id}/renew`).set(m.auth);
    assert.equal(res.body.error.code, 'RENEWAL_LIMIT');
  });

  test('cannot renew while someone is waiting for the title', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const book = await makeBook();
    const loan = await borrow(a, { bookId: book.id });
    await api().post('/api/holds').set(b.auth).send({ bookId: book.id });
    const res = await api().post(`/api/loans/${loan.body.id}/renew`).set(a.auth);
    assert.equal(res.body.error.code, 'TITLE_ON_HOLD');
  });

  test('cannot renew an overdue book', async () => {
    const m = await makeUser();
    const book = await makeBook();
    const loan = await borrow(m, { bookId: book.id });
    await backdateLoan(loan.body.id, { dueDaysAgo: 1 });
    const res = await api().post(`/api/loans/${loan.body.id}/renew`).set(m.auth);
    assert.equal(res.body.error.code, 'OVERDUE');
  });

  test("someone else's loan looks like it does not exist", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const book = await makeBook();
    const loan = await borrow(a, { bookId: book.id });
    const res = await api().post(`/api/loans/${loan.body.id}/renew`).set(b.auth);
    assert.equal(res.status, 404);
    const list = await api().get('/api/loans').query({ memberId: a.id }).set(b.auth);
    assert.equal(list.body.length, 0);
  });
});

describe('hold queue', () => {
  test('cannot hold a title that is on the shelf', async () => {
    const m = await makeUser();
    const book = await makeBook();
    const res = await api().post('/api/holds').set(m.auth).send({ bookId: book.id });
    assert.equal(res.body.error.code, 'COPY_AVAILABLE');
  });

  test('first come, first served: the returned copy is kept for the first in line', async () => {
    const [reader, first, second] = await Promise.all([makeUser(), makeUser('member', 'First'), makeUser()]);
    const book = await makeBook();
    await borrow(reader, { bookId: book.id });
    const h1 = await api().post('/api/holds').set(first.auth).send({ bookId: book.id });
    const h2 = await api().post('/api/holds').set(second.auth).send({ bookId: book.id });
    assert.deepEqual([h1.body.position, h2.body.position], [1, 2]);
    const dup = await api().post('/api/holds').set(first.auth).send({ bookId: book.id });
    assert.equal(dup.body.error.code, 'ALREADY_HOLDING');

    const ret = await giveBack(book.barcodes[0]);
    assert.equal(ret.body.heldFor.memberName, 'First');

    // Second in line cannot take it, even by scanning the barcode.
    const steal = await borrow(librarian, { barcode: book.barcodes[0], memberId: second.id });
    assert.equal(steal.body.error.code, 'RESERVED_FOR_ANOTHER');
    // First in line borrows it by title; their hold is fulfilled.
    assert.equal((await borrow(first, { bookId: book.id })).status, 201);
    const mine = await api().get('/api/holds').set(first.auth);
    assert.equal(mine.body.length, 0);
    const theirs = await api().get('/api/holds').set(second.auth);
    assert.equal(theirs.body[0].position, 1);
  });

  test('cancelling a ready hold passes the copy to the next person', async () => {
    const [reader, a, b] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const book = await makeBook();
    await borrow(reader, { bookId: book.id });
    const ha = await api().post('/api/holds').set(a.auth).send({ bookId: book.id });
    await api().post('/api/holds').set(b.auth).send({ bookId: book.id });
    await giveBack(book.barcodes[0]);

    assert.equal((await api().delete(`/api/holds/${ha.body.id}`).set(a.auth)).status, 204);
    const bHolds = await api().get('/api/holds').set(b.auth);
    assert.equal(bHolds.body[0].status, 'ready');
  });

  test('uncollected holds expire and the copy moves down the queue', async () => {
    const [reader, a, b] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const book = await makeBook();
    await borrow(reader, { bookId: book.id });
    const ha = await api().post('/api/holds').set(a.auth).send({ bookId: book.id });
    await api().post('/api/holds').set(b.auth).send({ bookId: book.id });
    await giveBack(book.barcodes[0]);
    await query(`UPDATE holds SET expires_at = now() - interval '1 hour' WHERE id = $1`, [ha.body.id]);

    const run = await api().post('/api/holds/expire').set(librarian.auth);
    assert.ok(run.body.expired >= 1);
    assert.equal((await api().get('/api/holds').set(a.auth)).body.length, 0);
    assert.equal((await api().get('/api/holds').set(b.auth)).body[0].status, 'ready');
  });

  test('every change is written to the audit log', async () => {
    const res = await api().get('/api/staff/audit').query({ limit: 200 }).set(librarian.auth);
    const actions = new Set(res.body.map((a) => a.action));
    for (const a of ['loan.checkout', 'loan.return', 'hold.place', 'hold.ready', 'hold.expire']) {
      assert.ok(actions.has(a), `missing ${a}`);
    }
  });
});
