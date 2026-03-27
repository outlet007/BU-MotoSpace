const router = require('express').Router();
const pool = require('../config/database');
const { isAuthenticated, isHead } = require('../middleware/auth');

router.use(isAuthenticated);

// GET /rules
router.get('/', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rules = await conn.query(
      `SELECT r.*, a.full_name as created_by_name,
              (SELECT COUNT(*) FROM violations v WHERE v.rule_id = r.id) as violation_count
       FROM rules r
       LEFT JOIN admins a ON r.created_by = a.id
       ORDER BY r.created_at DESC`
    );
    res.render('rules/index', { title: 'จัดการกฎ - BU MotoSpace', rules });
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลได้');
    res.redirect('/dashboard');
  } finally {
    if (conn) conn.release();
  }
});

// POST /rules — Create new rule (head+ only)
router.post('/', isHead, async (req, res) => {
  const { rule_name, description, max_violations, penalty } = req.body;
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(
      'INSERT INTO rules (rule_name, description, max_violations, penalty, created_by) VALUES (?, ?, ?, ?, ?)',
      [rule_name, description, parseInt(max_violations) || 3, penalty, req.session.admin.id]
    );
    req.flash('success', 'เพิ่มกฎเรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/rules');
});

// POST /rules/:id/update
router.post('/:id/update', isHead, async (req, res) => {
  const { rule_name, description, max_violations, penalty, is_active } = req.body;
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(
      'UPDATE rules SET rule_name = ?, description = ?, max_violations = ?, penalty = ?, is_active = ? WHERE id = ?',
      [rule_name, description, parseInt(max_violations) || 3, penalty, is_active === 'on' ? 1 : 0, req.params.id]
    );
    req.flash('success', 'อัปเดตกฎเรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/rules');
});

// POST /rules/:id/delete
router.post('/:id/delete', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query('DELETE FROM rules WHERE id = ?', [req.params.id]);
    req.flash('success', 'ลบกฎเรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถลบกฎได้ (อาจมีการอ้างอิงอยู่)');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/rules');
});

module.exports = router;
