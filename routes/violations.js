const router = require('express').Router();
const pool = require('../config/database');
const upload = require('../middleware/upload');
const { isAuthenticated } = require('../middleware/auth');
const { generateHash, compareHashes } = require('../utils/imageHash');
const path = require('path');

router.use(isAuthenticated);

// GET /violations
router.get('/', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const { search, rule_id, page = 1 } = req.query;
    const limit = 20;
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    const params = [];
    if (search) {
      where += ' AND (r.id_number LIKE ? OR r.first_name LIKE ? OR r.last_name LIKE ? OR r.license_plate LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (rule_id) { where += ' AND v.rule_id = ?'; params.push(rule_id); }

    const [countResult] = await conn.query(
      `SELECT COUNT(*) as cnt FROM violations v JOIN registrations r ON v.registration_id = r.id ${where}`, params
    );
    const total = parseInt(countResult.cnt);
    const totalPages = Math.ceil(total / limit);

    const violations = await conn.query(
      `SELECT v.*, r.first_name, r.last_name, r.license_plate, r.user_type, r.id_number,
              ru.rule_name, a.full_name as recorded_by_name
       FROM violations v
       JOIN registrations r ON v.registration_id = r.id
       JOIN rules ru ON v.rule_id = ru.id
       JOIN admins a ON v.recorded_by = a.id
       ${where}
       ORDER BY v.recorded_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const rules = await conn.query('SELECT * FROM rules WHERE is_active = TRUE');

    // Top 5 violators
    const topViolators = (await conn.query(
      `SELECT r.id_number, r.first_name, r.last_name, r.license_plate, COUNT(*) as cnt
       FROM violations v
       JOIN registrations r ON v.registration_id = r.id
       GROUP BY v.registration_id
       ORDER BY cnt DESC
       LIMIT 5`
    )).map(row => ({ ...row, cnt: Number(row.cnt) }));

    // Top 5 violated rules
    const topRules = (await conn.query(
      `SELECT ru.rule_name, COUNT(*) as cnt
       FROM violations v
       JOIN rules ru ON v.rule_id = ru.id
       GROUP BY v.rule_id
       ORDER BY cnt DESC
       LIMIT 5`
    )).map(row => ({ ...row, cnt: Number(row.cnt) }));

    res.render('violations/index', {
      title: 'บันทึกการกระทำผิด - BU MotoSpace',
      violations,
      rules,
      total,
      totalPages,
      currentPage: parseInt(page),
      search: search || '',
      rule_id: rule_id || '',
      topViolators,
      topRules,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลได้');
    res.redirect('/dashboard');
  } finally {
    if (conn) conn.release();
  }
});

// GET /violations/create — must be before /:id
router.get('/create', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rules = await conn.query('SELECT * FROM rules WHERE is_active = TRUE');
    const reg_id = req.query.reg_id || '';
    let selectedReg = null;

    if (reg_id) {
      // Fetch the specific registrant
      const [reg] = await conn.query(
        'SELECT id, id_number, user_type, first_name, last_name, license_plate, province, phone FROM registrations WHERE id = ?',
        [reg_id]
      );
      selectedReg = reg || null;
    }

    res.render('violations/create', {
      title: 'บันทึกการกระทำผิด - BU MotoSpace',
      rules,
      reg_id,
      selectedReg,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
    res.redirect('/registrations');
  } finally {
    if (conn) conn.release();
  }
});

// GET /violations/:id — Violation detail
router.get('/:id', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [violation] = await conn.query(
      `SELECT v.*, r.id_number, r.user_type, r.first_name, r.last_name, r.license_plate, r.province, r.phone,
              r.motorcycle_photo, r.plate_photo, r.id_card_photo,
              ru.rule_name, ru.description as rule_desc, ru.max_violations, ru.penalty,
              a.full_name as recorded_by_name
       FROM violations v
       JOIN registrations r ON v.registration_id = r.id
       JOIN rules ru ON v.rule_id = ru.id
       JOIN admins a ON v.recorded_by = a.id
       WHERE v.id = ?`,
      [req.params.id]
    );

    if (!violation) {
      req.flash('error', 'ไม่พบข้อมูลการกระทำผิด');
      return res.redirect('/violations');
    }

    // Count how many times this person violated this rule
    const [vioCount] = await conn.query(
      'SELECT COUNT(*) as cnt FROM violations WHERE registration_id = ? AND rule_id = ?',
      [violation.registration_id, violation.rule_id]
    );

    res.render('violations/detail', {
      title: `รายละเอียดการกระทำผิด #${violation.id} - BU MotoSpace`,
      v: violation,
      violationCount: parseInt(vioCount.cnt),
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลได้');
    res.redirect('/violations');
  } finally {
    if (conn) conn.release();
  }
});

// POST /violations
router.post('/', upload.single('evidence_photo'), async (req, res) => {
  const { registration_id, rule_id, description } = req.body;
  let conn;
  try {
    conn = await pool.getConnection();

    // Check violation limit
    const [rule] = await conn.query('SELECT * FROM rules WHERE id = ?', [rule_id]);
    const [countResult] = await conn.query(
      'SELECT COUNT(*) as cnt FROM violations WHERE registration_id = ? AND rule_id = ?',
      [registration_id, rule_id]
    );
    const currentCount = parseInt(countResult.cnt);

    if (currentCount >= rule.max_violations) {
      req.flash('error', `ผู้นี้ครบจำนวนครั้งที่กำหนด (${rule.max_violations} ครั้ง) สำหรับกฎ "${rule.rule_name}" แล้ว`);
      return res.redirect('/violations/create');
    }

    const evidencePhoto = req.file ? '/uploads/evidence/' + req.file.filename : null;

    await conn.query(
      'INSERT INTO violations (registration_id, rule_id, description, evidence_photo, recorded_by) VALUES (?, ?, ?, ?, ?)',
      [registration_id, rule_id, description, evidencePhoto, req.session.admin.id]
    );

    const remaining = rule.max_violations - currentCount - 1;
    if (remaining <= 0) {
      req.flash('warning', `⚠️ ผู้นี้ครบจำนวนครั้งที่กำหนดแล้ว — บทลงโทษ: ${rule.penalty}`);
    } else {
      req.flash('success', `บันทึกเรียบร้อย (เหลือโอกาสอีก ${remaining} ครั้ง)`);
    }
    res.redirect('/registrations/' + registration_id);
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด: ' + err.message);
    res.redirect('/violations/create?reg_id=' + registration_id);
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;

