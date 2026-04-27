const router = require('express').Router();
const bcrypt = require('bcrypt');
const pool = require('../config/database');
const rateLimit = require('express-rate-limit');

// ─── Brute Force Protection ───────────────────────────────────────────────────
// จำกัด POST /auth/login ไม่เกิน 10 ครั้ง / 15 นาที / IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 นาที
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    req.flash('error', '⚠️ พยายาม login มากเกินไป กรุณารอ 15 นาทีแล้วลองใหม่');
    res.redirect('/auth/login');
  },
  skip: (req) => req.method !== 'POST',
});

// Dummy hash สำหรับ timing-safe comparison (ป้องกัน username enumeration)
const DUMMY_HASH = '$2b$10$X9hGFkKQGNkKI5YEpxjNuuTISbLMIYbz5l4Gfb8hCGTgqvZ5pQ7qi';

// GET /auth/login
router.get('/login', (req, res) => {
  if (req.session.admin) {
    if (req.session.admin.role === 'officer') {
      return res.redirect('/violations');
    }
    return res.redirect('/dashboard');
  }

  // แสดงข้อความแจ้งเมื่อ session หมดเวลาเนื่องจากไม่มีการใช้งาน
  if (req.query.reason === 'idle') {
    req.flash('error', '⏰ เซสชันหมดอายุเนื่องจากไม่มีการใช้งานนานเกิน 1 ชั่วโมง กรุณาเข้าสู่ระบบใหม่อีกครั้ง');
  }

  res.render('login', { title: 'เข้าสู่ระบบ - BU MotoSpace' });
});

// POST /auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query('SELECT * FROM admins WHERE username = ? AND is_active = TRUE', [username]);

    // ─── Timing-safe: ถ้า user ไม่มีในระบบ ให้ยังรัน bcrypt เพื่อไม่ให้ timing ต่างกัน
    if (rows.length === 0) {
      await bcrypt.compare(password, DUMMY_HASH); // ใช้เวลาเท่ากับกรณี user มี
      req.flash('error', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      return res.redirect('/auth/login');
    }

    const admin = rows[0];
    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) {
      req.flash('error', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      return res.redirect('/auth/login');
    }

    // ─── Session Fixation Fix: regenerate session ID หลัง login สำเร็จ ────
    const adminData = {
      id: admin.id,
      username: admin.username,
      full_name: admin.full_name,
      role: admin.role,
    };

    req.session.regenerate((err) => {
      if (err) {
        console.error('Session regenerate error:', err);
        req.flash('error', 'เกิดข้อผิดพลาดในระบบ');
        return res.redirect('/auth/login');
      }
      req.session.admin = adminData;
      // ─── เริ่มนับ idle timer ทันทีหลัง login สำเร็จ ───────────────────────
      req.session.lastActivity = Date.now();
      req.flash('success', `ยินดีต้อนรับ ${admin.full_name}`);
      if (admin.role === 'officer') {
        res.redirect('/violations');
      } else {
        res.redirect('/dashboard');
      }
    });
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
    // ─── ลบ session cookie ออกจาก browser ด้วย ─────────────────────────────
    res.clearCookie('connect.sid', { path: '/' });
    res.redirect('/auth/login');
  });
});

module.exports = router;
