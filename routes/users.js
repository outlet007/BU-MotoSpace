const router = require('express').Router();
const pool = require('../config/database');
const bcrypt = require('bcrypt');
const { isAuthenticated, isSuperAdmin } = require('../middleware/auth');

router.use(isAuthenticated);
router.use(isSuperAdmin);

/* Lazy migration — add email/phone columns if they don't exist yet */
async function ensureColumns(conn) {
  await conn.query(`
    ALTER TABLE admins
      ADD COLUMN IF NOT EXISTS email VARCHAR(200) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS phone VARCHAR(20)  DEFAULT NULL
  `).catch(() => {
    // MariaDB < 10.3 doesn't support ADD COLUMN IF NOT EXISTS; try individually
    return conn.query("ALTER TABLE admins ADD COLUMN email VARCHAR(200) DEFAULT NULL")
      .catch(() => {}) // already exists
      .then(() => conn.query("ALTER TABLE admins ADD COLUMN phone VARCHAR(20) DEFAULT NULL"))
      .catch(() => {}); // already exists
  });
}

// GET /users
router.get('/', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureColumns(conn);
    const users = await conn.query(
      'SELECT id, username, full_name, email, phone, role, is_active, created_at FROM admins ORDER BY created_at DESC'
    );
    res.render('users/index', { title: 'จัดการผู้ใช้ - BU MotoSpace', users });
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลได้');
    res.redirect('/dashboard');
  } finally {
    if (conn) conn.release();
  }
});

// POST /users — Create
router.post('/', async (req, res) => {
  const { username, password, full_name, email, phone, role } = req.body;
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureColumns(conn);
    const hashedPw = await bcrypt.hash(password, 10);
    await conn.query(
      'INSERT INTO admins (username, password, full_name, email, phone, role) VALUES (?, ?, ?, ?, ?, ?)',
      [username, hashedPw, full_name, email || null, phone || null, role]
    );
    req.flash('success', 'เพิ่มผู้ใช้เรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'ชื่อผู้ใช้นี้มีอยู่แล้ว');
    } else {
      req.flash('error', 'เกิดข้อผิดพลาด');
    }
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/users');
});

// POST /users/:id/update
router.post('/:id/update', async (req, res) => {
  const { full_name, email, phone, role, is_active, password } = req.body;
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureColumns(conn);
    if (password && password.trim()) {
      const hashedPw = await bcrypt.hash(password, 10);
      await conn.query(
        'UPDATE admins SET full_name = ?, email = ?, phone = ?, role = ?, is_active = ?, password = ? WHERE id = ?',
        [full_name, email || null, phone || null, role, is_active === 'on' ? 1 : 0, hashedPw, req.params.id]
      );
    } else {
      await conn.query(
        'UPDATE admins SET full_name = ?, email = ?, phone = ?, role = ?, is_active = ? WHERE id = ?',
        [full_name, email || null, phone || null, role, is_active === 'on' ? 1 : 0, req.params.id]
      );
    }
    req.flash('success', 'อัปเดตผู้ใช้เรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/users');
});

// POST /users/:id/delete
router.post('/:id/delete', async (req, res) => {
  if (parseInt(req.params.id) === req.session.admin.id) {
    req.flash('error', 'ไม่สามารถลบตัวเองได้');
    return res.redirect('/users');
  }
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query('DELETE FROM admins WHERE id = ?', [req.params.id]);
    req.flash('success', 'ลบผู้ใช้เรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถลบผู้ใช้ได้');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/users');
});

module.exports = router;
