const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const { pool, query } = require('../src/db');
const { signToken } = require('../src/middleware/auth');

const app = createApp();
const api = () => request(app);

let seq = 0;
const HASH = bcrypt.hashSync('password123', 4);

async function reset() {
  await query('TRUNCATE audit_log, fines, holds, loans, copies, books, users RESTART IDENTITY CASCADE');
}

async function makeUser(role = 'member', name) {
  seq += 1;
  const { rows: [u] } = await query(
    `INSERT INTO users (name, email, password_hash, role, card_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name || `${role} ${seq}`, `${role}${seq}@test.local`, HASH, role, `SM-TEST-${String(seq).padStart(4, '0')}`]
  );
  return { ...u, token: signToken(u), auth: { Authorization: `Bearer ${signToken(u)}` } };
}

async function makeBook({ title = `Book ${++seq}`, copies = 1, replacementCents = 2000, subjects = [] } = {}) {
  const { rows: [b] } = await query(
    `INSERT INTO books (title, author, subjects, replacement_cents) VALUES ($1, 'Test Author', $2, $3) RETURNING *`,
    [title, subjects, replacementCents]
  );
  const barcodes = [];
  for (let i = 1; i <= copies; i++) {
    const barcode = `T${b.id}-${i}`;
    await query('INSERT INTO copies (book_id, barcode) VALUES ($1, $2)', [b.id, barcode]);
    barcodes.push(barcode);
  }
  return { ...b, barcodes };
}

/** Moves a loan's dates into the past, as if time had passed. */
async function backdateLoan(loanId, { dueDaysAgo }) {
  await query(
    `UPDATE loans SET loaned_at = now() - make_interval(days => $2 + 14),
                      due_at    = now() - make_interval(days => $2) - interval '1 minute'
      WHERE id = $1`,
    [loanId, dueDaysAgo]
  );
}

const close = () => pool.end();

module.exports = { api, reset, makeUser, makeBook, backdateLoan, query, close };
