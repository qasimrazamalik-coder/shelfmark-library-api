const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, reset, makeUser, makeBook, close } = require('./helpers');

let librarian, member;

before(async () => {
  await reset();
  librarian = await makeUser('librarian');
  member = await makeUser('member');
  await makeBook({ title: 'Designing Data-Intensive Applications', subjects: ['databases'], copies: 2 });
  await makeBook({ title: 'Database Internals', subjects: ['databases'], copies: 0 });
  await makeBook({ title: 'The Pragmatic Programmer', subjects: ['craft'], copies: 1 });
});
after(close);

describe('catalogue', () => {
  test('prefix search finds partial words', async () => {
    const res = await api().get('/api/books').query({ q: 'datab' });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
  });

  test('search input cannot break the query syntax', async () => {
    const res = await api().get('/api/books').query({ q: "'); DROP TABLE books; -- & | !" });
    assert.equal(res.status, 200);
    const all = await api().get('/api/books');
    assert.equal(all.body.total, 3);
  });

  test('filters by subject and availability', async () => {
    const res = await api().get('/api/books').query({ subject: 'databases', available: 'true' });
    assert.deepEqual(res.body.items.map((b) => b.title), ['Designing Data-Intensive Applications']);
    assert.equal(res.body.items[0].availableCopies, 2);
  });

  test('paginates with a stable total', async () => {
    const res = await api().get('/api/books').query({ limit: 2, page: 2 });
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.total, 3);
  });

  test('only staff can add books', async () => {
    const body = { title: 'Refactoring', author: 'Martin Fowler', subjects: ['Craft'] };
    assert.equal((await api().post('/api/books').set(member.auth).send(body)).status, 403);
    const res = await api().post('/api/books').set(librarian.auth).send(body);
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.subjects, ['craft']);
  });

  test('ISBN is validated and unique', async () => {
    const bad = await api().post('/api/books').set(librarian.auth).send({ title: 'X', author: 'Y', isbn: '123' });
    assert.equal(bad.status, 400);
    const ok = { title: 'Clean Architecture', author: 'Robert C. Martin', isbn: '9780134494166' };
    assert.equal((await api().post('/api/books').set(librarian.auth).send(ok)).status, 201);
    const dup = await api().post('/api/books').set(librarian.auth).send(ok);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'ISBN_TAKEN');
  });

  test('duplicate barcodes are rejected by the database', async () => {
    const book = await makeBook({ copies: 1 });
    const res = await api().post(`/api/books/${book.id}/copies`).set(librarian.auth).send({ barcode: book.barcodes[0] });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'BARCODE_TAKEN');
  });

  test('a new copy goes straight to the first person waiting', async () => {
    const book = await makeBook({ copies: 0 });
    const hold = await api().post('/api/holds').set(member.auth).send({ bookId: book.id });
    assert.equal(hold.status, 201);
    assert.equal(hold.body.position, 1);

    const add = await api().post(`/api/books/${book.id}/copies`).set(librarian.auth).send({ barcode: 'NEW-0001' });
    assert.equal(add.status, 201);
    assert.equal(add.body.copy.status, 'on_hold_shelf');
    assert.equal(add.body.routedToHoldId, hold.body.id);
  });

  test('unknown book is a 404, bad id is a 400', async () => {
    assert.equal((await api().get('/api/books/99999')).status, 404);
    assert.equal((await api().get('/api/books/abc')).status, 400);
  });
});
