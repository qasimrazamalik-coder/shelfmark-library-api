const express = require('express');
const { z } = require('zod');
const { query, transaction, audit } = require('../../db');
const { validate } = require('../../middleware/validate');
const { authenticate, requireStaff, isStaff } = require('../../middleware/auth');
const { notFound, conflict } = require('../../errors');
const { routeFreedCopy, queuePosition } = require('./queue');

const router = express.Router();
router.use(authenticate);

const id = z.coerce.number().int().positive();

const HOLD_SELECT = `
  SELECT h.id, h.book_id AS "bookId", b.title, b.author, h.member_id AS "memberId", u.name AS "memberName",
         h.status, h.created_at AS "createdAt", h.ready_at AS "readyAt", h.expires_at AS "pickupBy",
         c.barcode, c.shelf_location AS "shelfLocation",
         CASE WHEN h.status = 'waiting' THEN
           (SELECT count(*) FROM holds h2 WHERE h2.book_id = h.book_id AND h2.status = 'waiting'
              AND (h2.created_at, h2.id) <= (h.created_at, h.id))::int END AS position
    FROM holds h
    JOIN books b ON b.id = h.book_id
    JOIN users u ON u.id = h.member_id
    LEFT JOIN copies c ON c.id = h.copy_id`;

router.get('/', validate({ query: z.object({ scope: z.enum(['mine', 'shelf', 'all']).default('mine') }) }), async (req, res) => {
  // Members can only ever list their own holds.
  const scope = isStaff(req.user) ? req.valid.query.scope : 'mine';
  const where = {
    mine: `h.member_id = $1 AND h.status IN ('waiting','ready')`,
    shelf: `h.status = 'ready' AND $1::bigint IS NOT NULL`,
    all: `h.status IN ('waiting','ready') AND $1::bigint IS NOT NULL`,
  }[scope];
  const { rows } = await query(`${HOLD_SELECT} WHERE ${where} ORDER BY h.status DESC, h.expires_at, h.created_at`, [req.user.id]);
  res.json(rows);
});

router.post('/', validate({ body: z.object({ bookId: id, memberId: id.optional() }) }), async (req, res) => {
  const memberId = isStaff(req.user) && req.valid.body.memberId ? req.valid.body.memberId : req.user.id;
  const { bookId } = req.valid.body;

  const hold = await transaction(async (client) => {
    // Lock the title so "is anything on the shelf?" and "join the queue"
    // are one atomic decision.
    const { rows: [book] } = await client.query('SELECT id FROM books WHERE id = $1 FOR UPDATE', [bookId]);
    if (!book) throw notFound('Book');

    const { rows: [avail] } = await client.query(
      `SELECT count(*) AS n FROM copies WHERE book_id = $1 AND status = 'available'`, [bookId]);
    if (avail.n > 0) throw conflict('COPY_AVAILABLE', 'A copy is on the shelf right now. Borrow it instead of holding.');

    const { rows: [has] } = await client.query(
      `SELECT 1 FROM loans l JOIN copies c ON c.id = l.copy_id
        WHERE l.member_id = $1 AND c.book_id = $2 AND l.returned_at IS NULL`, [memberId, bookId]);
    if (has) throw conflict('ALREADY_BORROWED', 'You already have this title out.');

    const { rows: [row] } = await client.query(
      `INSERT INTO holds (book_id, member_id) VALUES ($1, $2) RETURNING *`, [bookId, memberId]);
    await audit(client, req.user.id, 'hold.place', 'hold', row.id, { bookId, memberId });
    return { ...row, position: await queuePosition(client, row) };
  });
  res.status(201).json({ id: hold.id, bookId: hold.book_id, status: hold.status, position: hold.position });
});

router.delete('/:id', validate({ params: z.object({ id }) }), async (req, res) => {
  await transaction(async (client) => {
    const { rows: [hold] } = await client.query('SELECT * FROM holds WHERE id = $1 FOR UPDATE', [req.valid.params.id]);
    if (!hold || (hold.member_id !== req.user.id && !isStaff(req.user))) throw notFound('Hold');
    if (!['waiting', 'ready'].includes(hold.status)) throw conflict('HOLD_CLOSED', 'This hold is no longer active.');
    await client.query(`UPDATE holds SET status = 'cancelled', closed_at = now() WHERE id = $1`, [hold.id]);
    // A cancelled ready hold frees its copy for the next person in line.
    if (hold.status === 'ready') await routeFreedCopy(client, hold.copy_id, req.user.id);
    await audit(client, req.user.id, 'hold.cancel', 'hold', hold.id);
  });
  res.status(204).end();
});

/**
 * Ready holds that were not collected in time expire, and their copies move
 * on down the queue. Runs on a timer in server.js and can be triggered by staff.
 */
async function expireOverdueHolds(actorId = null) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE holds SET status = 'expired', closed_at = now()
        WHERE id IN (SELECT id FROM holds WHERE status = 'ready' AND expires_at < now() FOR UPDATE SKIP LOCKED)
        RETURNING *`
    );
    for (const h of rows) {
      await audit(client, actorId, 'hold.expire', 'hold', h.id);
      await routeFreedCopy(client, h.copy_id, actorId);
    }
    return rows.length;
  });
}

router.post('/expire', requireStaff, async (req, res) => {
  res.json({ expired: await expireOverdueHolds(req.user.id) });
});

module.exports = { router, expireOverdueHolds };
