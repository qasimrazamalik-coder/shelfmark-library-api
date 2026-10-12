const jwt = require('jsonwebtoken');
const config = require('../config');
const { unauthorized, forbidden } = require('../errors');

const STAFF = ['librarian', 'admin'];

function signToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role, name: user.name }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

/** Requires a valid Bearer token and puts { id, role, name } on req.user. */
function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized());
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { id: Number(payload.sub), role: payload.role, name: payload.name };
    next();
  } catch {
    next(unauthorized('Your session has expired. Sign in again.'));
  }
}

const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user?.role) ? next() : next(forbidden());

const requireStaff = requireRole(...STAFF);
const isStaff = (user) => STAFF.includes(user.role);

module.exports = { signToken, authenticate, requireRole, requireStaff, isStaff };
