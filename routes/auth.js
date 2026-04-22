const router = require('express').Router();
const bcrypt = require('bcrypt');
const pool = require('../config/database');

// GET /auth/login
router.get('/login', (req, res) => {
  if (req.session.admin) {
    if (req.session.admin.role === 'officer') {
      return res.redirect('/violations');
    }
    return res.redirect('/dashboard');
  }
  res.render('login', { title: 'เข้าสู่ระบบ - BU MotoSpace' });
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query('SELECT * FROM admins WHERE username = ? AND is_active = TRUE', [username]);
    if (rows.length === 0) {
      req.flash('error', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      return res.redirect('/auth/login');
    }
    const admin = rows[0];
    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) {
      req.flash('error', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      return res.redirect('/auth/login');
    }
    req.session.admin = {
      id: admin.id,
      username: admin.username,
      full_name: admin.full_name,
      role: admin.role,
    };
    req.flash('success', `ยินดีต้อนรับ ${admin.full_name}`);
    if (admin.role === 'officer') {
      res.redirect('/violations');
    } else {
      res.redirect('/dashboard');
    }
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาดในระบบ');
    res.redirect('/auth/login');
  } finally {
    if (conn) conn.release();
  }
});

// GET /auth/logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/auth/login');
  });
});

module.exports = router;
