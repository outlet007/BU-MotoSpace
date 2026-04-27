/**
 * Lightweight CSRF protection using Node.js built-in crypto.
 * Strategy: Synchronizer Token Pattern stored in the session.
 * - Token is generated per-session (not per-request) for SPA friendliness
 * - Verified on every state-changing request (POST/PUT/DELETE/PATCH)
 * - Safe methods (GET/HEAD/OPTIONS) are skipped automatically
 *
 * IMPORTANT: For multipart/form-data routes (file uploads), the global
 * csrfMiddleware skips validation because req.body is not yet parsed by multer.
 * Those routes must add verifyCsrf AFTER their upload middleware instead.
 */
const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Generate a cryptographically-secure CSRF token and store it in the session.
 */
function generateCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

/**
 * Core CSRF validation — returns true if the token is valid.
 */
function validateCsrf(req) {
  const sessionToken = req.session && req.session.csrfToken;
  const bodyToken    = req.body   && req.body._csrf;
  const headerToken  = req.headers['x-csrf-token'];
  const submitted    = bodyToken || headerToken;
  return !!(sessionToken && submitted && sessionToken === submitted);
}

/**
 * Standalone CSRF middleware for use INSIDE routes after multer.
 * Because multer must parse multipart/form-data before _csrf is readable,
 * routes with file uploads cannot rely on the global csrfMiddleware.
 *
 * Usage:
 *   const { verifyCsrf } = require('../middleware/csrf');
 *   router.post('/create', upload.single('photo'), verifyCsrf, handler);
 */
function verifyCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!validateCsrf(req)) {
    const err = new Error('CSRF token mismatch');
    err.status = 403;
    err.code = 'EBADCSRFTOKEN';
    return next(err);
  }
  next();
}

/**
 * Global Express middleware — validates CSRF on all non-safe methods,
 * EXCEPT multipart/form-data (handled per-route via verifyCsrf after multer).
 */
function csrfMiddleware(req, res, next) {
  req.csrfToken = () => generateCsrfToken(req);

  if (SAFE_METHODS.has(req.method)) return next();

  // Skip multipart — body not yet parsed; route will call verifyCsrf after multer
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) return next();

  if (!validateCsrf(req)) {
    const err = new Error('CSRF token mismatch');
    err.status = 403;
    err.code = 'EBADCSRFTOKEN';
    return next(err);
  }

  next();
}

module.exports = { csrfMiddleware, generateCsrfToken, verifyCsrf };
