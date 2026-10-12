const { Pool, types } = require('pg');
const config = require('./config');

// BIGINT (int8) comes back as a string by default. Our ids and counts fit
// comfortably in a JS number, so parse them for a cleaner API.
types.setTypeParser(20, (v) => Number(v));

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

pool.on('error', (err) => console.error('Unexpected idle client error', err));

const query = (text, params) => pool.query(text, params);

/**
 * Runs `fn` inside a transaction on a dedicated client.
 * Commits on success, rolls back on any thrown error.
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Records who did what. Always called inside the same transaction as the change. */
function audit(client, actorId, action, entity, entityId, details = {}) {
  return client.query(
    'INSERT INTO audit_log (actor_id, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
    [actorId, action, entity, entityId, details]
  );
}

module.exports = { pool, query, transaction, audit };
