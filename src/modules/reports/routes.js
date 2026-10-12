const express = require('express');
const { z } = require('zod');
const { query, transaction, audit } = require('../../db');
const { validate } = require('../../middleware/validate');
const { authenticate, requireStaff } = require('../../middleware/auth');
const { notFound, conflict } = require('../../errors');
const { routeFreedCopy } = require('../holds/queue');

const router = express.Router();
router.use(authenticate, requireStaff);

// One round trip for the desk's at-a-glance numbers.
router.get('/summary', async (_req, res) => {
  const { rows: [s] } = await query(`
    SELECT
      (SELECT count(*) FROM books) AS titles,
      (SELECT count(*) FROM copies WHERE status NOT IN ('withdrawn','lost')) AS copies,
      (SELECT count(*) FROM loans WHERE returned_at IS NULL) AS on_loan,
      (SELECT count(*) FROM loans WHERE returned_at IS NULL AND due_at < now()) AS overdue,
      (SELECT count(*) FROM holds WHERE status = 'ready') AS on_hold_shelf,
      (SELECT count(*) FROM holds WHERE status = 'waiting') AS waiting_holds,
      (SELECT coalesce(sum(amount_cents),0) FROM fines WHERE paid_at IS NULL AND waived_at IS NULL) AS unpaid_cents,
      (SELECT count(*) FROM loans WHERE loaned_at::date = current_date) AS loans_today,
      (SELECT count(*) FROM loans WHERE returned_at::date = current_date) AS returns_today`);
  res.json({
    titles: s.titles, copies: s.copies, onLoan: s.on_loan, overdue: s.overdue,
    onHoldShelf: s.on_hold_shelf, waitingHolds: s.waiting_holds, unpaidCents: s.unpaid_cents,
    loansToday: s.loans_today, returnsToday: s.returns_today,
  });
});

// Most borrowed titles over a window, using a window function for ranking.
router.get('/popular', validate({ query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) }),
  async (req, res) => {
    const { rows } = await query(
      `SELECT b.id AS "bookId", b.title, b.author, count(l.id)::int AS loans,
              rank() OVER (ORDER BY count(l.id) DESC)::int AS rank
         FROM loans l JOIN copies c ON c.id = l.copy_id JOIN books b ON b.id = c.book_id
        WHERE l.loaned_at > now() - make_interval(days => $1)
        GROUP BY b.id ORDER BY loans DESC, b.title LIMIT 10`,
      [req.valid.query.days]
    );
    res.json(rows);
  });

// Loans per day for the last N days, gaps filled with generate_series.
router.get('/activity', validate({ query: z.object({ days: z.coerce.number().int().min(7).max(90).default(14) }) }),
  async (req, res) => {
    const { rows } = await query(
      `SELECT d::date AS day,
              (SELECT count(*) FROM loans WHERE loaned_at::date = d::date)::int AS loans,
              (SELECT count(*) FROM loans WHERE returned_at::date = d::date)::int AS returns
         FROM generate_series(current_date - ($1::int - 1), current_date, interval '1 day') d
        ORDER BY d`,
      [req.valid.query.days]
    );
    res.json(rows);
  });

router.get('/audit', validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) }),
  async (req, res) => {
    const { rows } = await query(
      `SELECT a.id, a.action, a.entity, a.entity_id AS "entityId", a.details, a.at, u.name AS actor
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        ORDER BY a.id DESC LIMIT $1`,
      [req.valid.query.limit]
    );
    res.json(rows);
  });

// Copy maintenance lives here with the other staff-only tools.
router.patch('/copies/:barcode',
  validate({ params: z.object({ barcode: z.string().trim().toUpperCase() }),
    body: z.object({ status: z.enum(['available', 'withdrawn', 'lost']), shelfLocation: z.string().trim().max(40).optional() }) }),
  async (req, res) => {
    const copy = await transaction(async (client) => {
      const { rows: [c] } = await client.query('SELECT * FROM copies WHERE barcode = $1 FOR UPDATE', [req.valid.params.barcode]);
      if (!c) throw notFound('Copy');
      if (['on_loan', 'on_hold_shelf'].includes(c.status)) {
        throw conflict('COPY_IN_CIRCULATION', 'Return the copy or clear its hold before changing its status.');
      }
      const { status, shelfLocation } = req.valid.body;
      await client.query('UPDATE copies SET shelf_location = coalesce($2, shelf_location) WHERE id = $1', [c.id, shelfLocation ?? null]);
      if (status === 'available') await routeFreedCopy(client, c.id, req.user.id); // a found copy may go straight to the queue
      else await client.query('UPDATE copies SET status = $2 WHERE id = $1', [c.id, status]);
      await audit(client, req.user.id, 'copy.status', 'copy', c.id, { from: c.status, to: status });
      const { rows: [fresh] } = await client.query('SELECT id, barcode, status, shelf_location AS "shelfLocation" FROM copies WHERE id = $1', [c.id]);
      return fresh;
    });
    res.json(copy);
  });

module.exports = { router };
