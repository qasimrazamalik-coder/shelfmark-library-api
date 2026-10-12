const express = require('express');
const { z } = require('zod');
const { query, transaction } = require('../../db');
const { validate } = require('../../middleware/validate');
const { authenticate, requireStaff, isStaff } = require('../../middleware/auth');
const svc = require('./service');

const router = express.Router();
router.use(authenticate);

const id = z.coerce.number().int().positive();
const barcode = z.string().trim().toUpperCase().min(4).max(20);

const checkoutSchema = z.object({
  bookId: id.optional(),
  barcode: barcode.optional(),
  memberId: id.optional(),
  memberCard: z.string().trim().toUpperCase().optional(),
}).refine((b) => b.bookId || b.barcode, { message: 'Give a bookId or a barcode.' });

const listSchema = z.object({
  memberId: id.optional(),
  status: z.enum(['open', 'returned', 'all']).default('open'),
  overdue: z.enum(['true', 'false']).optional(),
});

router.get('/standing', async (req, res) => {
  res.json(await svc.getStanding({ query }, req.user.id));
});

router.get('/', validate({ query: listSchema }), async (req, res) => {
  const q = req.valid.query;
  // Members only ever see their own loans, whatever they ask for.
  const memberId = isStaff(req.user) ? q.memberId : req.user.id;
  const open = q.status === 'all' ? null : q.status === 'open';
  res.json(await svc.listLoans({ query }, { memberId, open, overdueOnly: q.overdue === 'true' }));
});

router.post('/', validate({ body: checkoutSchema }), async (req, res) => {
  const body = { ...req.valid.body };
  if (body.memberCard) {
    // Desk staff usually scan a library card rather than typing an id.
    const { rows: [m] } = await query('SELECT id FROM users WHERE card_number = $1', [body.memberCard]);
    body.memberId = m?.id ?? -1;
  }
  const loan = await transaction((client) => svc.checkout(client, req.user, body));
  res.status(201).json(loan);
});

router.post('/return', requireStaff, validate({ body: z.object({ barcode }) }), async (req, res) => {
  res.json(await transaction((client) => svc.returnCopy(client, req.user, req.valid.body)));
});

router.post('/:id/renew', validate({ params: z.object({ id }) }), async (req, res) => {
  res.json(await transaction((client) => svc.renew(client, req.user, req.valid.params.id)));
});

router.post('/:id/lost', requireStaff, validate({ params: z.object({ id }) }), async (req, res) => {
  res.json(await transaction((client) => svc.declareLost(client, req.user, req.valid.params.id)));
});

module.exports = { router };
