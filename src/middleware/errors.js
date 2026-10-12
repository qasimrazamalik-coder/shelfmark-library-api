const { AppError } = require('../errors');

// Translate the database's own constraint violations into clean API errors.
// The schema enforces invariants (unique barcodes, one open loan per copy...),
// so these are real business signals, not just plumbing failures.
const PG_UNIQUE = '23505';
const PG_FOREIGN_KEY = '23503';
const PG_CHECK = '23514';

const constraintMessages = {
  users_email_lower_uq: ['EMAIL_TAKEN', 'An account with that email already exists.'],
  copies_barcode_key: ['BARCODE_TAKEN', 'That barcode is already in use.'],
  books_isbn_key: ['ISBN_TAKEN', 'A book with that ISBN is already in the catalogue.'],
  loans_one_open_per_copy: ['COPY_ALREADY_ON_LOAN', 'That copy is already on loan.'],
  holds_one_active_per_member: ['ALREADY_HOLDING', 'You already have a hold on this title.'],
};

function notFoundRoute(req, _res, next) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  if (err.type === 'entity.parse.failed') {
    err = new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  } else if (err.code === PG_UNIQUE) {
    const [code, message] = constraintMessages[err.constraint] || ['DUPLICATE', 'That record already exists.'];
    err = new AppError(409, code, message);
  } else if (err.code === PG_FOREIGN_KEY) {
    err = new AppError(409, 'REFERENCED', 'That record is still referenced by other data.');
  } else if (err.code === PG_CHECK) {
    err = new AppError(400, 'CONSTRAINT_FAILED', 'A value is outside the allowed range.');
  }

  if (!(err instanceof AppError)) {
    console.error(err);
    err = new AppError(500, 'INTERNAL', 'Something went wrong on the server.');
  }
  res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
}

module.exports = { errorHandler, notFoundRoute };
