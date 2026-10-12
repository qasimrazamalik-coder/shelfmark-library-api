const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, reset, makeUser, close } = require('./helpers');

before(reset);
after(close);

describe('auth', () => {
  test('registers a member with a library card number', async () => {
    const res = await api().post('/api/auth/register')
      .send({ name: 'Hina Raza', email: 'Hina@Example.com', password: 'longenough' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'member');
    assert.equal(res.body.user.email, 'hina@example.com');
    assert.match(res.body.user.cardNumber, /^SM-\d{4}-\d{4}$/);
    assert.ok(res.body.token);
  });

  test('email uniqueness is case-insensitive', async () => {
    const res = await api().post('/api/auth/register')
      .send({ name: 'Someone Else', email: 'HINA@example.com', password: 'longenough' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'EMAIL_TAKEN');
  });

  test('rejects weak input with field-level details', async () => {
    const res = await api().post('/api/auth/register').send({ name: 'X', email: 'nope', password: 'short' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    const fields = res.body.error.details.map((d) => d.field).sort();
    assert.deepEqual(fields, ['email', 'name', 'password']);
  });

  test('login gives the same error for wrong password and unknown email', async () => {
    const a = await api().post('/api/auth/login').send({ email: 'hina@example.com', password: 'wrong-pass' });
    const b = await api().post('/api/auth/login').send({ email: 'ghost@example.com', password: 'wrong-pass' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.body.error.message, b.body.error.message);
  });

  test('login works and /me returns the profile', async () => {
    const login = await api().post('/api/auth/login').send({ email: 'hina@example.com', password: 'longenough' });
    assert.equal(login.status, 200);
    const me = await api().get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    assert.equal(me.body.name, 'Hina Raza');
  });

  test('protected routes need a valid token', async () => {
    assert.equal((await api().get('/api/loans')).status, 401);
    const bad = await api().get('/api/loans').set('Authorization', 'Bearer not-a-token');
    assert.equal(bad.status, 401);
  });

  test('members cannot reach staff routes', async () => {
    const m = await makeUser('member');
    const res = await api().get('/api/staff/summary').set(m.auth);
    assert.equal(res.status, 403);
  });

  test('malformed JSON gets a clear 400', async () => {
    const res = await api().post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_JSON');
  });
});
