const express = require('express');
const { z } = require('zod');
const { query, transaction, audit } = require('../../db');
const { validate } = require('../../middleware/validate');
const { authenticate, requireStaff, requireRole } = require('../../middleware/auth');
const { notFound, conflict } = require('../../errors');
const { routeFreedCopy } = require('../holds/queue');

const router = express.Router();

const id = z.coerce.number().int().positive();

const searchSchema = z.object({
  q: z.string().trim().max(100).optional(),
  subject: z.string().trim().max(40).optional(),
  available: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const bookSchema = z.object({
  isbn: z.string().trim().regex(/^(97[89])?\d{9}[\dX]$/, 'ISBN must be 10 or 13 digits.').optional(),
  title: z.string().trim().min(1).max(200),
  author: z.string().trim().min(1).max(120),
  publishedYear: z.number().int().min(1400).max(2100).optional(),
  subjects: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(10).default([]),
  replacementCents: z.number().int().min(0).max(100000).default(2500),
});

const copySchema = z.object({
  barcode: z.string().trim().regex(/^[A-Z0-9-]{4,20}$/, 'Barcodes use capital letters, digits and dashes.'),
  shelfLocation: z.string().trim().max(40).optional(),
});

/**
 * Turns free text into a prefix tsquery: "dune herb" -> 'dune:* & herb:*'.
 * Only letters and digits survive, so user input can never break the query syntax.
 */
function toPrefixQuery(text) {
  const terms = (text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return terms.length ? terms.map((t) => `${t}:*`).join(' & ') : null;
}

const toBook = (r) => ({
  id: r.id,
  isbn: r.isbn,
  title: r.title,
  author: r.author,
  publishedYear: r.published_year,
  subjects: r.subjects,
  replacementCents: r.replacement_cents,
  totalCopies: r.total_copies,
  availableCopies: r.available_copies,
  queueLength: r.queue_length,
});

router.get('/', validate({ query: searchSchema }), async (req, res) => {
  const { q, subject, available, page, limit } = req.valid.query;
  const tsq = toPrefixQuery(q);
  const { rows } = await query(
    `SELECT b.*, a.total_copies, a.available_copies, a.queue_length,
            CASE WHEN $1::text IS NULL THEN 0 ELSE ts_rank(b.search, to_tsquery('simple', $1)) END AS rank,
            count(*) OVER () AS total
       FROM books b
       JOIN book_availability a ON a.book_id = b.id
      WHERE ($1::text IS NULL OR b.search @@ to_tsquery('simple', $1) OR b.isbn = $2)
        AND ($3::text IS NULL OR $3 = ANY (b.subjects))
        AND ($4::boolean IS NOT TRUE OR a.available_copies > 0)
      ORDER BY rank DESC, b.title
      LIMIT $5 OFFSET $6`,
    [tsq, q || null, subject || null, available === 'true', limit, (page - 1) * limit]
  );
  res.json({ items: rows.map(toBook), page, limit, total: rows[0]?.total ?? 0 });
});

router.get('/subjects', async (_req, res) => {
  const { rows } = await query(
    `SELECT s AS subject, count(*) AS books FROM books, unnest(subjects) s GROUP BY s ORDER BY books DESC, s LIMIT 30`
  );
  res.json(rows);
});

router.get('/:id', validate({ params: z.object({ id }) }), async (req, res) => {
  const { rows: [book] } = await query(
    `SELECT b.*, a.total_copies, a.available_copies, a.queue_length
       FROM books b JOIN book_availability a ON a.book_id = b.id WHERE b.id = $1`,
    [req.valid.params.id]
  );
  if (!book) throw notFound('Book');
  const { rows: copies } = await query(
    `SELECT c.id, c.barcode, c.shelf_location AS "shelfLocation", c.status,
            l.due_at AS "dueAt"
       FROM copies c
       LEFT JOIN loans l ON l.copy_id = c.id AND l.returned_at IS NULL
      WHERE c.book_id = $1 AND c.status <> 'withdrawn'
      ORDER BY c.barcode`,
    [book.id]
  );
  res.json({ ...toBook(book), copies });
});

router.post('/', authenticate, requireStaff, validate({ body: bookSchema }), async (req, res) => {
  const b = req.valid.body;
  const book = await transaction(async (client) => {
    const { rows: [row] } = await client.query(
      `INSERT INTO books (isbn, title, author, published_year, subjects, replacement_cents)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [b.isbn ?? null, b.title, b.author, b.publishedYear ?? null, b.subjects, b.replacementCents]
    );
    await audit(client, req.user.id, 'book.create', 'book', row.id, { title: row.title });
    return row;
  });
  res.status(201).json(toBook({ ...book, total_copies: 0, available_copies: 0, queue_length: 0 }));
});

router.patch('/:id', authenticate, requireStaff,
  validate({ params: z.object({ id }), body: bookSchema.partial() }), async (req, res) => {
    const b = req.valid.body;
    const { rows: [row] } = await query(
      `UPDATE books SET
          isbn = COALESCE($2, isbn), title = COALESCE($3, title), author = COALESCE($4, author),
          published_year = COALESCE($5, published_year), subjects = COALESCE($6, subjects),
          replacement_cents = COALESCE($7, replacement_cents)
        WHERE id = $1 RETURNING id`,
      [req.valid.params.id, b.isbn, b.title, b.author, b.publishedYear, b.subjects, b.replacementCents]
    );
    if (!row) throw notFound('Book');
    const { rows: [full] } = await query(
      `SELECT b.*, a.total_copies, a.available_copies, a.queue_length
         FROM books b JOIN book_availability a ON a.book_id = b.id WHERE b.id = $1`, [row.id]);
    res.json(toBook(full));
  });

router.delete('/:id', authenticate, requireRole('admin'), validate({ params: z.object({ id }) }), async (req, res) => {
  await transaction(async (client) => {
    const { rows: [book] } = await client.query('SELECT id FROM books WHERE id = $1 FOR UPDATE', [req.valid.params.id]);
    if (!book) throw notFound('Book');
    const { rows: [history] } = await client.query(
      `SELECT count(*) AS n FROM loans l JOIN copies c ON c.id = l.copy_id WHERE c.book_id = $1`, [book.id]);
    if (history.n > 0) {
      throw conflict('HAS_HISTORY', 'This title has loan history. Withdraw its copies instead of deleting it.');
    }
    await client.query(`DELETE FROM holds WHERE book_id = $1`, [book.id]);
    await client.query(`DELETE FROM copies WHERE book_id = $1`, [book.id]);
    await client.query(`DELETE FROM books WHERE id = $1`, [book.id]);
    await audit(client, req.user.id, 'book.delete', 'book', book.id);
  });
  res.status(204).end();
});

// Adding a copy may immediately satisfy someone waiting in the hold queue.
router.post('/:id/copies', authenticate, requireStaff,
  validate({ params: z.object({ id }), body: copySchema }), async (req, res) => {
    const result = await transaction(async (client) => {
      const { rows: [book] } = await client.query('SELECT id FROM books WHERE id = $1', [req.valid.params.id]);
      if (!book) throw notFound('Book');
      const { rows: [copy] } = await client.query(
        `INSERT INTO copies (book_id, barcode, shelf_location) VALUES ($1, $2, $3) RETURNING *`,
        [book.id, req.valid.body.barcode, req.valid.body.shelfLocation ?? null]
      );
      await audit(client, req.user.id, 'copy.create', 'copy', copy.id, { barcode: copy.barcode });
      const routedTo = await routeFreedCopy(client, copy.id, req.user.id);
      const { rows: [fresh] } = await client.query('SELECT * FROM copies WHERE id = $1', [copy.id]);
      return { copy: fresh, routedToHoldId: routedTo?.id ?? null };
    });
    res.status(201).json(result);
  });

module.exports = { router, toPrefixQuery };
