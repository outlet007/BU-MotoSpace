const router = require('express').Router();
const pool = require('../config/database');
const bcrypt = require('bcrypt');
const { isAuthenticated, isSuperAdmin } = require('../middleware/auth');

router.use(isAuthenticated);
router.use(isSuperAdmin);

async function ensureDepartmentsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      department_name VARCHAR(200) NOT NULL UNIQUE,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
}

/* Lazy migration — add profile columns if they don't exist yet */
async function ensureColumns(conn) {
  await ensureDepartmentsTable(conn);
  await conn.query(`
    ALTER TABLE admins
      ADD COLUMN IF NOT EXISTS email VARCHAR(200) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS phone VARCHAR(20)  DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS department_id INT DEFAULT NULL
  `).catch(() => {
    // MariaDB < 10.3 doesn't support ADD COLUMN IF NOT EXISTS; try individually
    return conn.query("ALTER TABLE admins ADD COLUMN email VARCHAR(200) DEFAULT NULL")
      .catch(() => {}) // already exists
      .then(() => conn.query("ALTER TABLE admins ADD COLUMN phone VARCHAR(20) DEFAULT NULL"))
      .catch(() => {})
      .then(() => conn.query("ALTER TABLE admins ADD COLUMN department_id INT DEFAULT NULL"))
      .catch(() => {}); // already exists
  });
}

// GET /users
router.get('/', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureColumns(conn);

    const search        = (req.query.search        || '').trim();
    const role_filter   = (req.query.role_filter   || '').trim();
    const status_filter = (req.query.status_filter || '').trim();
    const conditions    = [];
    const params        = [];

    if (search) {
      const s = `%${search}%`;
      conditions.push(`(a.username LIKE ? OR a.full_name LIKE ? OR a.email LIKE ? OR a.phone LIKE ? OR d.department_name LIKE ?)`);
      params.push(s, s, s, s, s);
    }
    if (role_filter) {
      conditions.push(`a.role = ?`);
      params.push(role_filter);
    }
    if (status_filter === 'active') {
      conditions.push(`a.is_active = 1`);
    } else if (status_filter === 'inactive') {
      conditions.push(`a.is_active = 0`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const users = await conn.query(
      `SELECT a.id, a.username, a.full_name, a.email, a.phone, a.department_id,
              d.department_name, a.role, a.is_active, a.created_at
       FROM admins a
       LEFT JOIN departments d ON d.id = a.department_id
       ${where}
       ORDER BY a.created_at DESC`,
      params
    );
    const departments = await conn.query('SELECT id, department_name FROM departments ORDER BY department_name');
    res.render('users/index', { title: 'จัดการผู้ใช้ - BU MotoSpace', users, departments, search, role_filter, status_filter });
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
  const departmentId = req.body.department_id ? parseInt(req.body.department_id, 10) : null;
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureColumns(conn);
    const hashedPw = await bcrypt.hash(password, 10);
    await conn.query(
      'INSERT INTO admins (username, password, full_name, email, phone, department_id, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [username, hashedPw, full_name, email || null, phone || null, departmentId, role]
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
  const departmentId = req.body.department_id ? parseInt(req.body.department_id, 10) : null;
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureColumns(conn);
    if (password && password.trim()) {
      const hashedPw = await bcrypt.hash(password, 10);
      await conn.query(
        'UPDATE admins SET full_name = ?, email = ?, phone = ?, department_id = ?, role = ?, is_active = ?, password = ? WHERE id = ?',
        [full_name, email || null, phone || null, departmentId, role, is_active === 'on' ? 1 : 0, hashedPw, req.params.id]
      );
    } else {
      await conn.query(
        'UPDATE admins SET full_name = ?, email = ?, phone = ?, department_id = ?, role = ?, is_active = ? WHERE id = ?',
        [full_name, email || null, phone || null, departmentId, role, is_active === 'on' ? 1 : 0, req.params.id]
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

// POST /users/:id/deactivate — Soft delete (ปิดสถานะ ไม่ลบจริง)
router.post('/:id/deactivate', async (req, res) => {
  if (parseInt(req.params.id) === req.session.admin.id) {
    req.flash('error', 'ไม่สามารถปิดตัวเองได้');
    return res.redirect('/users');
  }
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query('UPDATE admins SET is_active = 0 WHERE id = ?', [req.params.id]);
    req.flash('success', 'ปิดการใช้งานผู้ใช้เรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/users');
});

// POST /users/:id/restore — กู้คืนผู้ใช้
router.post('/:id/restore', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query('UPDATE admins SET is_active = 1 WHERE id = ?', [req.params.id]);
    req.flash('success', 'กู้คืนผู้ใช้เรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/users');
});

// POST /users/:id/delete — Hard delete
router.post('/:id/delete', async (req, res) => {
  if (parseInt(req.params.id, 10) === req.session.admin.id) {
    req.flash('error', 'ไม่สามารถลบบัญชีของตัวเองได้');
    return res.redirect('/users');
  }

  let conn;
  try {
    conn = await pool.getConnection();
    const [user] = await conn.query(
      'SELECT id, username, full_name FROM admins WHERE id = ?',
      [req.params.id]
    );

    if (!user) {
      req.flash('error', 'ไม่พบผู้ใช้ที่ต้องการลบ');
      return res.redirect('/users');
    }

    await conn.query('DELETE FROM admins WHERE id = ?', [req.params.id]);
    req.flash('success', `ลบผู้ใช้ "${user.full_name}" ออกจากระบบถาวรเรียบร้อยแล้ว`);
  } catch (err) {
    console.error('POST /users/:id/delete error:', err);
    req.flash('error', 'ไม่สามารถลบผู้ใช้ถาวรได้: ' + err.message);
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/users');
});

module.exports = router;
