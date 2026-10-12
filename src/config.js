// Central configuration. Everything comes from environment variables with
// development defaults, so `npm run db` + `npm run setup` + `npm start` just works.
const fs = require('fs');
const path = require('path');

// Tiny .env loader (avoids an extra dependency). Real env vars win.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env.NODE_ENV || 'development';

const config = {
  env,
  port: Number(process.env.PORT || 3001),
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5541/shelfmark',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  // Circulation policy. Kept in one place so the report can reference it.
  policy: {
    loanDays: Number(process.env.LOAN_DAYS || 14),
    maxActiveLoans: Number(process.env.MAX_ACTIVE_LOANS || 5),
    maxRenewals: Number(process.env.MAX_RENEWALS || 2),
    finePerDayCents: Number(process.env.FINE_PER_DAY_CENTS || 25),
    blockAtFinesCents: Number(process.env.BLOCK_AT_FINES_CENTS || 1000),
    holdPickupDays: Number(process.env.HOLD_PICKUP_DAYS || 3),
  },
};

if (env === 'production' && config.jwtSecret === 'dev-only-secret-change-me') {
  throw new Error('JWT_SECRET must be set in production');
}

module.exports = config;
