const router = require('express').Router();
const pool = require('../config/database');
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

async function ensureUserDepartmentColumn(conn) {
  await ensureDepartmentsTable(conn);
  await conn.query(`
    ALTER TABLE admins
      ADD COLUMN IF NOT EXISTS department_id INT DEFAULT NULL
  `).catch(() => conn.query('ALTER TABLE admins ADD COLUMN department_id INT DEFAULT NULL').catch(() => {}));
}

router.get('/', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureUserDepartmentColumn(conn);

    const departments = await conn.query(`
      SELECT d.*, COUNT(a.id) AS user_count
      FROM departments d
      LEFT JOIN admins a ON a.department_id = d.id
      GROUP BY d.id, d.department_name, d.description, d.created_at, d.updated_at
      ORDER BY d.department_name
    `);

    res.render('departments/index', {
      title: 'หน่วยงาน - BU MotoSpace',
      departments,
    });
  } catch (err) {
    console.error('GET /departments error:', err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลหน่วยงานได้');
    res.redirect('/dashboard');
  } finally {
    if (conn) conn.release();
  }
});

router.post('/', async (req, res) => {
  const departmentName = (req.body.department_name || '').trim();
  const description = (req.body.description || '').trim() || null;

  if (!departmentName) {
    req.flash('error', 'กรุณาระบุชื่อหน่วยงาน');
    return res.redirect('/departments');
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await ensureDepartmentsTable(conn);
    await conn.query(
      'INSERT INTO departments (department_name, description) VALUES (?, ?)',
      [departmentName, description]
    );
    req.flash('success', 'เพิ่มหน่วยงานเรียบร้อยแล้ว');
  } catch (err) {
    console.error('POST /departments error:', err);
    req.flash('error', err.code === 'ER_DUP_ENTRY' ? 'มีชื่อหน่วยงานนี้อยู่แล้ว' : 'ไม่สามารถเพิ่มหน่วยงานได้');
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/departments');
});

router.post('/:id/update', async (req, res) => {
  const departmentName = (req.body.department_name || '').trim();
  const description = (req.body.description || '').trim() || null;

  if (!departmentName) {
    req.flash('error', 'กรุณาระบุชื่อหน่วยงาน');
    return res.redirect('/departments');
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await ensureDepartmentsTable(conn);
    await conn.query(
      'UPDATE departments SET department_name = ?, description = ? WHERE id = ?',
      [departmentName, description, req.params.id]
    );
    req.flash('success', 'อัปเดตหน่วยงานเรียบร้อยแล้ว');
  } catch (err) {
    console.error('POST /departments/:id/update error:', err);
    req.flash('error', err.code === 'ER_DUP_ENTRY' ? 'มีชื่อหน่วยงานนี้อยู่แล้ว' : 'ไม่สามารถอัปเดตหน่วยงานได้');
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/departments');
});

router.post('/:id/delete', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureUserDepartmentColumn(conn);

    const [usage] = await conn.query(
      'SELECT COUNT(*) AS cnt FROM admins WHERE department_id = ?',
      [req.params.id]
    );

    if (Number(usage.cnt) > 0) {
      req.flash('error', 'ไม่สามารถลบหน่วยงานที่ยังมีผู้ใช้สังกัดอยู่ได้');
      return res.redirect('/departments');
    }

    await conn.query('DELETE FROM departments WHERE id = ?', [req.params.id]);
    req.flash('success', 'ลบหน่วยงานเรียบร้อยแล้ว');
  } catch (err) {
    console.error('POST /departments/:id/delete error:', err);
    req.flash('error', 'ไม่สามารถลบหน่วยงานได้');
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/departments');
});

module.exports = router;
