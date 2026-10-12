const config = require('../../config');
const { audit } = require('../../db');

/**
 * Decides where a physical copy goes when it comes free (returned, hold
 * cancelled/expired, or a new copy added): to the first person waiting in the
 * queue for that title, or back onto the open shelf.
 *
 * Must be called inside a transaction. FOR UPDATE SKIP LOCKED means two copies
 * of the same title being freed at the same moment will each claim a
 * different waiting hold instead of both grabbing the first one.
 */
async function routeFreedCopy(client, copyId, actorId) {
  const { rows: [copy] } = await client.query('SELECT * FROM copies WHERE id = $1 FOR UPDATE', [copyId]);

  const { rows: [next] } = await client.query(
    `SELECT * FROM holds
      WHERE book_id = $1 AND status = 'waiting'
      ORDER BY created_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED`,
    [copy.book_id]
  );

  if (!next) {
    await client.query(`UPDATE copies SET status = 'available' WHERE id = $1`, [copyId]);
    return null;
  }

  const { rows: [ready] } = await client.query(
    `UPDATE holds
        SET status = 'ready', copy_id = $2, ready_at = now(),
            expires_at = now() + make_interval(days => $3)
      WHERE id = $1
      RETURNING *`,
    [next.id, copyId, config.policy.holdPickupDays]
  );
  await client.query(`UPDATE copies SET status = 'on_hold_shelf' WHERE id = $1`, [copyId]);
  await audit(client, actorId, 'hold.ready', 'hold', ready.id, { copyId, memberId: ready.member_id });
  return ready;
}

/** Position in the queue (1-based) for a waiting hold. */
async function queuePosition(client, hold) {
  const { rows: [r] } = await client.query(
    `SELECT count(*) AS ahead FROM holds
      WHERE book_id = $1 AND status = 'waiting' AND (created_at, id) < ($2, $3)`,
    [hold.book_id, hold.created_at, hold.id]
  );
  return r.ahead + 1;
}

module.exports = { routeFreedCopy, queuePosition };
