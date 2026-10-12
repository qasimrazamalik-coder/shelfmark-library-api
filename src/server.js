const config = require('./config');
const { createApp } = require('./app');
const { pool } = require('./db');
const { expireOverdueHolds } = require('./modules/holds/routes');

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`Shelfmark running at http://localhost:${config.port}  (API docs: /api/docs)`);
});

// Background job: uncollected holds expire and their copies move down the queue.
const timer = setInterval(() => {
  expireOverdueHolds().then((n) => n && console.log(`Expired ${n} uncollected hold(s)`)).catch(console.error);
}, 60 * 1000);

function shutdown() {
  clearInterval(timer);
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
