const express = require('express');
const { z } = require('zod');
const { query, transaction, audit } = require('../../db');
const { validate } = require('../../middleware/validate');
const { authenticate, requireStaff, requireRole, isStaff } = require('../../middleware/auth');
const { notFound, conflict } = require('../../errors');

const router = express.Router();
router.use(authenticate);

const id = z.coerce.number().int().positive();

const FINE_SELECT = `
  SELECT f.id, f.member_id AS "memberId", u.name AS "memberName", f.amount_cents AS "amountCents",
         f.reason, f.created_at AS "createdAt", f.paid_at AS "paidAt", f.waived_at AS "waivedAt",
         f.waive_note AS "waiveNote", b.title,
         CASE WHEN f.paid_at IS NOT NULL THEN 'paid'
              WHEN f.waived_at IS NOT NULL THEN 'waived' ELSE 'unpaid' END AS status
    FROM fines f
    JOIN users u  ON u.id = f.member_id
    JOIN loans l  ON l.id = f.loan_id
    JOIN copies c ON c.id = l.copy_id
    JOIN books b  ON b.id = c.book_id`;

router.get('/', validate({ query: z.object({ memberId: id.optional(), status: z.enum(['unpaid', 'all']).default('all') }) }),
  async (req, res) => {
    const memberId = isStaff(req.user) ? req.valid.query.memberId ?? null : req.user.id;
    const { rows } = await query(
      `${FINE_SELECT}
        WHERE ($1::bigint IS NULL OR f.member_id = $1)
          AND ($2 = 'all' OR (f.paid_at IS NULL AND f.waived_at IS NULL))
        ORDER BY f.created_at DESC LIMIT 100`,
      [memberId, req.valid.query.status]
    );
    res.json(rows);
  });

// Settling a fine twice must be impossible, so the row is locked and checked.
async function settle(req, kind, note) {
  return transaction(async (client) => {
    const { rows: [fine] } = await client.query('SELECT * FROM fines WHERE id = $1 FOR UPDATE', [req.valid.params.id]);
    if (!fine) throw notFound('Fine');
    if (fine.paid_at || fine.waived_at) throw conflict('FINE_SETTLED', 'This fine has already been settled.');
    if (kind === 'pay') {
      await client.query('UPDATE fines SET paid_at = now() WHERE id = $1', [fine.id]);
    } else {
      await client.query('UPDATE fines SET waived_at = now(), waived_by = $2, waive_note = $3 WHERE id = $1',
        [fine.id, req.user.id, note]);
    }
    await audit(client, req.user.id, `fine.${kind}`, 'fine', fine.id, { amountCents: fine.amount_cents, note });
    const { rows: [view] } = await client.query(`${FINE_SELECT} WHERE f.id = $1`, [fine.id]);
    return view;
  });
}

router.post('/:id/pay', requireStaff, validate({ params: z.object({ id }) }), async (req, res) => {
  res.json(await settle(req, 'pay'));
});

// Waiving money is a judgment call, so only admins can do it, and they must say why.
router.post('/:id/waive', requireRole('admin'),
  validate({ params: z.object({ id }), body: z.object({ note: z.string().trim().min(5).max(200) }) }),
  async (req, res) => res.json(await settle(req, 'waive', req.valid.body.note)));

module.exports = { router };
