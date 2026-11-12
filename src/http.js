export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Turns database refusals into clear HTTP answers.
export function errorHandler(err, req, res, _next) {
  let status = err.status || 500;
  let message = err.message;
  if (!err.status && err.code) {
    if (err.code === '42501') status = 403;          // policy or trigger refusal
    else if (err.code === '23505') { status = 409; message = 'That record already exists (duplicate hospital number or membership).'; }
    else if (err.code === '22P02' || err.code === '22007' || err.code === '22008') { status = 400; message = 'One of the values is in the wrong format.'; }
    else if (err.code === '23514' || err.code === '23502') { status = 400; message = 'A required value is missing or not allowed.'; }
    else if (err.code === '23503') { status = 400; message = 'That linked record does not exist.'; }
    else if (err.code === 'P0002') { status = 404; message = 'This patient is not in your list.'; }
    else if (err.code === '22023') { status = 400; }
  }
  if (err.code === '42501' && /row-level security/.test(message)) {
    message = 'Your role does not allow this action for this patient.';
  }
  if (status >= 500) {
    console.error(err);
    message = 'Something went wrong on the server. Try again; if it keeps happening, tell your hospital admin.';
  }
  res.status(status).json({ error: message, ...(err.extra || {}) });
}

const str = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);
export const clean = {
  str,
  text: v => str(v, 20000),
  short: v => str(v, 300),
  date(v) {
    if (v == null || v === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new HttpError(400, 'Dates must be in YYYY-MM-DD format.');
    return String(v);
  },
  num(v, min, max, label) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
    return n;
  },
  uuid(v) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''))) {
      throw new HttpError(404, 'Not found.');
    }
    return String(v);
  },
};
