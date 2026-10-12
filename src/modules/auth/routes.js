const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { query } = require('../../db');
const { validate } = require('../../middleware/validate');
const { signToken, authenticate } = require('../../middleware/auth');
const { unauthorized, notFound } = require('../../errors');
const config = require('../../config');

const router = express.Router();

// Slow down password guessing. Disabled under test so suites can log in freely.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => config.env === 'test',
  handler: (_req, res) =>
    res.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many sign-in attempts. Try again in 15 minutes.' } }),
});

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, 'Use at least 8 characters.').max(72),
});
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, cardNumber: u.card_number });

// Library card numbers look like "SM-4821-0937": human-readable, not sequential.
const newCardNumber = () => {
  const n = crypto.randomInt(0, 1e8).toString().padStart(8, '0');
  return `SM-${n.slice(0, 4)}-${n.slice(4)}`;
};

router.post('/register', loginLimiter, validate({ body: registerSchema }), async (req, res) => {
  const { name, email, password } = req.valid.body;
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, card_number)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, email, hash, newCardNumber()]
  );
  res.status(201).json({ token: signToken(rows[0]), user: publicUser(rows[0]) });
});

router.post('/login', loginLimiter, validate({ body: loginSchema }), async (req, res) => {
  const { email, password } = req.valid.body;
  const { rows } = await query('SELECT * FROM users WHERE lower(email) = $1', [email]);
  // Same error for unknown email and wrong password, so accounts can't be probed.
  const ok = rows[0] && (await bcrypt.compare(password, rows[0].password_hash));
  if (!ok) throw unauthorized('Email or password is incorrect.');
  res.json({ token: signToken(rows[0]), user: publicUser(rows[0]) });
});

router.get('/me', authenticate, async (req, res) => {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) throw notFound('Account');
  res.json(publicUser(rows[0]));
});

module.exports = { router, publicUser, newCardNumber };
