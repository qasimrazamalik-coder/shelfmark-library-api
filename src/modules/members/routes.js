const express = require('express');
const { z } = require('zod');
const { query, transaction, audit } = require('../../db');
const { validate } = require('../../middleware/validate');
const { authenticate, requireStaff, requireRole } = require('../../middleware/auth');
const { notFound, conflict } = require('../../errors');
const { getStanding } = require('../loans/service');
const { publicUser } = require('../auth/routes');

const router = express.Router();
router.use(authenticate, requireStaff);

const id = z.coerce.number().int().positive();

// Desk lookup by name, email or card number.
router.get('/', validate({ query: z.object({ q: z.string().trim().max(80).default('') }) }), async (req, res) => {
  const like = `%${req.valid.query.q.replace(/[%_\\]/g, '\\$&')}%`;
  const { rows } = await query(
    `SELECT * FROM users
      WHERE name ILIKE $1 OR email ILIKE $1 OR card_number ILIKE $1
      ORDER BY name LIMIT 20`,
    [like]
  );
  res.json(rows.map(publicUser));
});

router.get('/:id', validate({ params: z.object({ id }) }), async (req, res) => {
  const { rows: [u] } = await query('SELECT * FROM users WHERE id = $1', [req.valid.params.id]);
  if (!u) throw notFound('Member');
  res.json({ ...publicUser(u), standing: await getStanding({ query }, u.id) });
});

router.patch('/:id/role', requireRole('admin'),
  validate({ params: z.object({ id }), body: z.object({ role: z.enum(['member', 'librarian', 'admin']) }) }),
  async (req, res) => {
    const user = await transaction(async (client) => {
      if (req.valid.params.id === req.user.id) throw conflict('SELF_ROLE_CHANGE', 'You cannot change your own role.');
      const { rows: [u] } = await client.query('UPDATE users SET role = $2 WHERE id = $1 RETURNING *',
        [req.valid.params.id, req.valid.body.role]);
      if (!u) throw notFound('Member');
      await audit(client, req.user.id, 'user.role', 'user', u.id, { role: u.role });
      return u;
    });
    res.json(publicUser(user));
  });

module.exports = { router };
