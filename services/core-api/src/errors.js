export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(err, req, res, _next) {
  if (err.status) return res.status(err.status).json({ error: err.message, details: err.details });
  // Postgres: foreign key / invalid input.
  if (err.code === '23503') return res.status(400).json({ error: 'referenced record does not exist' });
  if (err.code === '22P02' || err.code === '22007' || err.code === '22008') return res.status(400).json({ error: 'invalid input' });
  console.error('[api] unhandled', err);
  res.status(500).json({ error: 'internal error' });
}
