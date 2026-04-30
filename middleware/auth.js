// Authentication & Role-based Access Control Middleware

// ─── Idle Session Timeout ────────────────────────────────────────────────────
// ถ้า admin ไม่มีการใช้งานระบบใดๆ ภายใน IDLE_TIMEOUT_MS จะถูก logout อัตโนมัติ
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 ชั่วโมง
const SESSION_EXPIRED_MESSAGE = 'เซสชันของคุณหมดเวลาเนื่องจากไม่มีการใช้งาน กรุณาเข้าสู่ระบบใหม่อีกครั้ง';

/**
 * Middleware: ตรวจสอบ idle session ทุก request
 * - ถ้าไม่ได้ login → ข้ามการตรวจสอบ (ให้ isAuthenticated จัดการแทน)
 * - ถ้า login อยู่แต่ idle เกิน 1 ชม → ทำลาย session + redirect ไป login
 * - ถ้า login อยู่และยังใช้งานอยู่ → อัปเดตเวลากิจกรรมล่าสุด
 */
function idleSessionTimeout(req, res, next) {
  // ข้ามถ้ายังไม่ได้ login
  if (!req.session || !req.session.admin) {
    return next();
  }

  const now = Date.now();
  const lastActivity = req.session.lastActivity;

  // ถ้ามีค่า lastActivity และ idle เกินกำหนด → หมดเวลา
  if (lastActivity && (now - lastActivity) > IDLE_TIMEOUT_MS) {
    const wantsJson = req.xhr || req.headers['accept']?.includes('application/json');

    function respondAfterDestroy() {
      res.clearCookie('connect.sid', { path: '/' });

      if (wantsJson) {
        return res.status(401).json({
          error: 'session_expired',
          message: SESSION_EXPIRED_MESSAGE,
        });
      }

      return res.redirect('/auth/session-expired');
    }

    req.session.destroy((err) => {
      if (err) console.error('Session destroy error:', err);
      return respondAfterDestroy();
    });
    return;
  }

  // อัปเดตเวลากิจกรรมล่าสุด
  req.session.lastActivity = now;

  next();
}

function isAuthenticated(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }
  req.flash('error', 'กรุณาเข้าสู่ระบบก่อน');
  res.redirect('/auth/login');
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.admin) {
      req.flash('error', 'กรุณาเข้าสู่ระบบก่อน');
      return res.redirect('/auth/login');
    }
    if (roles.includes(req.session.admin.role)) {
      return next();
    }
    req.flash('error', 'คุณไม่มีสิทธิ์เข้าถึงหน้านี้');
    res.redirect('/dashboard');
  };
}

const isOfficer = requireRole('officer', 'head', 'superadmin');
const isHead = requireRole('head', 'superadmin');
const isSuperAdmin = requireRole('superadmin');

module.exports = {
  idleSessionTimeout,
  SESSION_EXPIRED_MESSAGE,
  isAuthenticated,
  requireRole,
  isOfficer,
  isHead,
  isSuperAdmin,
};
