/**
 * Signed URL utility for PDPA-compliant image access
 *
 * Every image URL is signed with HMAC-SHA256 and includes an expiry timestamp.
 * Even if a URL leaks, it becomes invalid after EXPIRY_SECONDS (default: 15 min).
 *
 * URL format: /img/<base64url-encoded-path>?exp=<unix-ts>&sig=<hmac-hex>
 */

const crypto = require('crypto');
const path = require('path');

const SECRET = process.env.IMAGE_SECRET || process.env.SESSION_SECRET || 'fallback_image_secret';
const EXPIRY_SECONDS = 15 * 60; // 15 minutes

/**
 * Generate a signed, time-limited URL for a stored file path.
 * @param {string} filePath  — e.g. "/uploads/id-cards/1234567890.jpg"
 * @param {number} [ttl]     — seconds until expiry (default 15 min)
 * @returns {string}         — signed URL ready to use in <img src="...">
 */
function generateSignedUrl(filePath, ttl = EXPIRY_SECONDS) {
  if (!filePath) return '';
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = `${filePath}:${exp}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  const encoded = Buffer.from(filePath).toString('base64url');
  return `/img/${encoded}?exp=${exp}&sig=${sig}`;
}

/**
 * Verify a signed URL's token and expiry.
 * @param {string} encoded  — base64url-encoded file path from URL param
 * @param {string} exp      — expiry unix timestamp (string from query)
 * @param {string} sig      — HMAC-SHA256 hex signature from query
 * @returns {string|null}   — decoded file path if valid, null if invalid/expired
 */
function verifySignedUrl(encoded, exp, sig) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const expNum = parseInt(exp, 10);

    // 1. Check expiry
    if (isNaN(expNum) || now > expNum) return null;

    // 2. Decode path
    const filePath = Buffer.from(encoded, 'base64url').toString('utf8');

    // 3. Recompute expected signature
    const payload = `${filePath}:${exp}`;
    const expectedSig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');

    // 4. Constant-time comparison (prevent timing attacks)
    if (sig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) return null;

    return filePath; // e.g. "/uploads/id-cards/xxx.jpg"
  } catch {
    return null;
  }
}

/**
 * Resolve decoded filePath to an absolute disk path.
 * filePath is stored as "/uploads/..." so strip the leading slash
 * and resolve relative to app root.
 * @param {string} filePath
 * @param {string} appRoot  — __dirname of app.js
 * @returns {string}
 */
function resolveFilePath(filePath, appRoot) {
  // filePath like "/uploads/id-cards/xxx.jpg"
  const relative = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  return path.join(appRoot, relative);
}

module.exports = { generateSignedUrl, verifySignedUrl, resolveFilePath };
