const router = require('express').Router();
const pool = require('../config/database');
const { isAuthenticated, isHead } = require('../middleware/auth');

router.use(isAuthenticated, isHead);

const SUMMONS_THRESHOLD_KEY = 'summons_total_threshold';
const DEFAULT_SUMMONS_THRESHOLD = 3;

async function ensureSettingsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(100) PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_by INT DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (updated_by) REFERENCES admins(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
}

async function getSummonsThreshold(conn) {
  await ensureSettingsTable(conn);
  const [row] = await conn.query(
    'SELECT setting_value FROM app_settings WHERE setting_key = ?',
    [SUMMONS_THRESHOLD_KEY]
  );
  const value = parseInt(row && row.setting_value, 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SUMMONS_THRESHOLD;
}

// GET /rules?format=json  — lightweight JSON list for dropdowns
router.get('/', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const summonsThreshold = await getSummonsThreshold(conn);
    const rules = await conn.query(
      `SELECT r.*, a.full_name as created_by_name,
              (SELECT COUNT(*) FROM violations v WHERE v.rule_id = r.id) as violation_count
       FROM rules r
       LEFT JOIN admins a ON r.created_by = a.id
       ORDER BY r.created_at DESC`
    );
    if (req.query.format === 'json') {
      return res.json(rules.map(r => ({ id: r.id, rule_name: r.rule_name })));
    }
    res.render('rules/index', { title: 'จัดการกฎ - BU MotoSpace', rules, summonsThreshold });
  } catch (err) {
    console.error(err);
    if (req.query.format === 'json') return res.json([]);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลได้');
    res.redirect('/dashboard');
  } finally {
    if (conn) conn.release();
  }
});

// POST /rules — Create new rule (head+ only)
router.post('/settings/summons-threshold', isHead, async (req, res) => {
  const threshold = Math.max(parseInt(req.body.summons_total_threshold, 10) || DEFAULT_SUMMONS_THRESHOLD, 1);
  let conn;

  try {
    conn = await pool.getConnection();
    await ensureSettingsTable(conn);
    await conn.query(
      `INSERT INTO app_settings (setting_key, setting_value, updated_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
      [SUMMONS_THRESHOLD_KEY, String(threshold), req.session.admin.id]
    );
    req.flash('success', `บันทึกจำนวนครั้งรวมสำหรับรายงานเรียกพบเป็น ${threshold} ครั้งเรียบร้อยแล้ว`);
  } catch (err) {
    console.error('POST /rules/settings/summons-threshold error:', err);
    req.flash('error', 'ไม่สามารถบันทึกจำนวนครั้งรวมสำหรับรายงานเรียกพบได้: ' + err.message);
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/rules');
});

router.post('/', isHead, async (req, res) => {
  const { rule_name, description, max_violations, penalty } = req.body;
  const cleanName = (rule_name || '').trim();
  const maxViolations = Math.max(parseInt(max_violations, 10) || 3, 1);

  if (!cleanName) {
    req.flash('error', 'กรุณาระบุชื่อกฎและข้อบังคับ');
    return res.redirect('/rules');
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(
      'INSERT INTO rules (rule_name, description, max_violations, penalty, created_by) VALUES (?, ?, ?, ?, ?)',
      [cleanName, description || null, maxViolations, penalty || null, req.session.admin.id]
    );
    req.flash('success', 'เพิ่มกฎเรียบร้อยแล้ว');
  } catch (err) {
    console.error('POST /rules error:', err);
    req.flash('error', 'เกิดข้อผิดพลาดในการเพิ่มกฎ: ' + err.message);
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/rules');
});

// POST /rules/:id/update
router.post('/:id/update', isHead, async (req, res) => {
  const { rule_name, description, max_violations, penalty, is_active } = req.body;
  const cleanName = (rule_name || '').trim();
  const maxViolations = Math.max(parseInt(max_violations, 10) || 3, 1);

  if (!cleanName) {
    req.flash('error', 'กรุณาระบุชื่อกฎและข้อบังคับ');
    return res.redirect('/rules');
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(
      'UPDATE rules SET rule_name = ?, description = ?, max_violations = ?, penalty = ?, is_active = ? WHERE id = ?',
      [cleanName, description || null, maxViolations, penalty || null, is_active === 'on' ? 1 : 0, req.params.id]
    );
    req.flash('success', 'อัปเดตกฎเรียบร้อยแล้ว');
  } catch (err) {
    console.error('POST /rules/:id/update error:', err);
    req.flash('error', 'เกิดข้อผิดพลาดในการอัปเดตกฎ: ' + err.message);
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/rules');
});

// POST /rules/:id/toggle — Enable/disable rule
router.post('/:id/toggle', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rule] = await conn.query('SELECT id, rule_name, is_active FROM rules WHERE id = ?', [req.params.id]);

    if (!rule) {
      req.flash('error', 'ไม่พบกฎและข้อบังคับที่ต้องการเปลี่ยนสถานะ');
      return res.redirect('/rules');
    }

    const nextStatus = rule.is_active ? 0 : 1;
    await conn.query('UPDATE rules SET is_active = ? WHERE id = ?', [nextStatus, req.params.id]);

    req.flash(
      'success',
      `${nextStatus ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}กฎ "${rule.rule_name}" เรียบร้อยแล้ว`
    );
  } catch (err) {
    console.error('POST /rules/:id/toggle error:', err);
    req.flash('error', 'เกิดข้อผิดพลาดในการเปลี่ยนสถานะกฎ: ' + err.message);
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/rules');
});

// POST /rules/:id/delete — Soft delete by hiding the rule, preserving history
router.post('/:id/delete', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query('UPDATE rules SET is_active = 0 WHERE id = ?', [req.params.id]);
    req.flash('success', 'ซ่อนกฎเรียบร้อยแล้ว ประวัติการใช้งานเดิมยังคงอยู่');
  } catch (err) {
    console.error('POST /rules/:id/delete error:', err);
    req.flash('error', 'ไม่สามารถซ่อนกฎได้: ' + err.message);
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/rules');
});

// POST /rules/:id/destroy — Permanently delete rule and related records
router.post('/:id/destroy', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rule] = await conn.query('SELECT id, rule_name FROM rules WHERE id = ?', [req.params.id]);

    if (!rule) {
      req.flash('error', 'ไม่พบกฎและข้อบังคับที่ต้องการลบถาวร');
      return res.redirect('/rules');
    }

    await conn.query('DELETE FROM rules WHERE id = ?', [req.params.id]);
    req.flash('success', `ลบกฎ "${rule.rule_name}" ออกจากระบบถาวรเรียบร้อยแล้ว`);
  } catch (err) {
    console.error('POST /rules/:id/destroy error:', err);
    req.flash('error', 'ไม่สามารถลบกฎถาวรได้: ' + err.message);
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/rules');
});

module.exports = router;
