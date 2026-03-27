// Authentication & Role-based Access Control Middleware

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
  isAuthenticated,
  requireRole,
  isOfficer,
  isHead,
  isSuperAdmin,
};
