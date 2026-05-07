const router = require('express').Router();
const pool = require('../config/database');
const upload = require('../middleware/upload');
const { isAuthenticated, isHead } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/csrf');
const { generateHash, compareHashes } = require('../utils/imageHash');
const path = require('path');

router.use(isAuthenticated);

function isValidDatetimeLocal(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '');
}

function toSqlDatetime(datetimeLocal) {
  return datetimeLocal.replace('T', ' ') + ':00';
}

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
      const searchTrimmed = search.trim().replace(/\s+/g, ' ');
      const s = `%${searchTrimmed}%`;
      const sNoSpace = `%${searchTrimmed.replace(/\s+/g, '')}%`;
      where += ` AND (
        r.id_number LIKE ? OR
        r.first_name LIKE ? OR
        r.last_name LIKE ? OR
        CONCAT(r.first_name, ' ', r.last_name) LIKE ? OR
        r.license_plate LIKE ? OR
        REPLACE(r.license_plate, ' ', '') LIKE ?
      )`;
      params.push(s, s, s, s, s, sNoSpace);
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

    // --- Approved Registrations list (for recording violations) ---
    const regSearch = req.query.reg_search || '';
    const regPage = parseInt(req.query.reg_page) || 1;
    const regLimit = 20;
    const regOffset = (regPage - 1) * regLimit;

    let regWhere = "WHERE r.status = 'approved'";
    const regParams = [];
    if (regSearch) {
      const st = regSearch.trim().replace(/\s+/g, ' ');
      const rs = `%${st}%`;
      const rsNoSpace = `%${st.replace(/\s+/g, '')}%`;
      regWhere += ` AND (
        r.id_number LIKE ? OR
        r.first_name LIKE ? OR
        r.last_name LIKE ? OR
        CONCAT(r.first_name, ' ', r.last_name) LIKE ? OR
        r.license_plate LIKE ? OR
        REPLACE(r.license_plate, ' ', '') LIKE ?
      )`;
      regParams.push(rs, rs, rs, rs, rs, rsNoSpace);
    }

    const [regCountResult] = await conn.query(
      `SELECT COUNT(*) as cnt FROM registrations r ${regWhere}`, regParams
    );
    const regTotal = parseInt(regCountResult.cnt);
    const regTotalPages = Math.ceil(regTotal / regLimit);

    const approvedRegistrations = await conn.query(
      `SELECT r.* FROM registrations r ${regWhere} ORDER BY r.registered_at DESC LIMIT ? OFFSET ?`,
      [...regParams, regLimit, regOffset]
    );

    let imageSearchResults = null;
    if (req.query.imageSearch && req.session.imageSearchResults) {
      imageSearchResults = req.session.imageSearchResults;
      delete req.session.imageSearchResults;
    }

    res.render('violations/index', {
      title: 'แจ้งการทำผิดกฎและข้อบังคับ - BU MotoSpace',
      violations,
      rules,
      total,
      totalPages,
      currentPage: parseInt(page),
      search: search || '',
      rule_id: rule_id || '',
      topViolators,
      topRules,
      approvedRegistrations,
      regTotal,
      regTotalPages,
      regCurrentPage: regPage,
      regSearch,
      imageSearchResults,
    });
  } catch (err) {
    console.error('GET /violations error:', err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลได้: ' + err.message);
    return res.render('violations/index', {
      title: 'แจ้งการทำผิดกฎและข้อบังคับ - BU MotoSpace',
      violations: [],
      rules: [],
      total: 0,
      totalPages: 0,
      currentPage: 1,
      search: req.query.search || '',
      rule_id: req.query.rule_id || '',
      topViolators: [],
      topRules: [],
      approvedRegistrations: [],
      regTotal: 0,
      regTotalPages: 0,
      regCurrentPage: 1,
      regSearch: '',
      imageSearchResults: null,
    });
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
      title: 'แจ้งการทำผิดกฎและข้อบังคับ - BU MotoSpace',
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
              DATE_FORMAT(v.recorded_at, '%Y-%m-%dT%H:%i') AS recorded_at_input,
              CONCAT('IR-', COALESCE(NULLIF(vt.type_code, ''), 'GEN'), '-', LPAD(v.id, 6, '0')) AS incident_code,
              r.motorcycle_photo, r.plate_photo, r.id_card_photo,
              ru.rule_name, ru.description as rule_desc, ru.max_violations, ru.penalty,
              a.full_name as recorded_by_name
       FROM violations v
       JOIN registrations r ON v.registration_id = r.id
       JOIN rules ru ON v.rule_id = ru.id
       LEFT JOIN violation_types vt ON ru.violation_type_id = vt.id
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

    const rules = await conn.query(
      `SELECT id, rule_name, is_active
       FROM rules
       ORDER BY is_active DESC, rule_name ASC`
    );

    res.render('violations/detail', {
      title: `รายละเอียดการกระทำผิด ${violation.incident_code} - BU MotoSpace`,
      v: violation,
      violationCount: parseInt(vioCount.cnt),
      rules,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลได้');
    res.redirect('/violations');
  } finally {
    if (conn) conn.release();
  }
});

// POST /violations — บันทึกเป็น "รายงานรอตรวจสอบ" ใน violation_reports (pending)
// ไม่บันทึกลง violations โดยตรง — ต้องรอผู้ดูแลระบบยืนยันก่อน
router.post('/', upload.single('evidence_photo'), verifyCsrf, async (req, res) => {
  const registrationId = parseInt(req.body.registration_id, 10);
  const ruleId = parseInt(req.body.rule_id, 10);
  const { description } = req.body;

  if (!Number.isFinite(registrationId) || registrationId <= 0 || !Number.isFinite(ruleId) || ruleId <= 0) {
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'กรุณาเลือกผู้ลงทะเบียนและกฎที่กระทำผิดให้ถูกต้อง');
    return res.redirect('/violations/create?reg_id=' + (req.body.registration_id || ''));
  }

  let conn;
  try {
    conn = await pool.getConnection();

    // Ensure violation_reports table exists
    await conn.query(`
      CREATE TABLE IF NOT EXISTS violation_reports (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        registration_id INT NOT NULL,
        rule_id        INT NOT NULL,
        description    TEXT,
        evidence_photo VARCHAR(500),
        reported_by    INT NOT NULL,
        reported_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status         ENUM('pending','confirmed','rejected') NOT NULL DEFAULT 'pending',
        reviewed_by    INT DEFAULT NULL,
        reviewed_at    TIMESTAMP NULL,
        review_note    TEXT,
        violation_id   INT DEFAULT NULL,
        FOREIGN KEY (registration_id) REFERENCES registrations(id) ON DELETE CASCADE,
        FOREIGN KEY (rule_id)         REFERENCES rules(id)          ON DELETE CASCADE,
        FOREIGN KEY (reported_by)     REFERENCES admins(id)         ON DELETE CASCADE,
        FOREIGN KEY (reviewed_by)     REFERENCES admins(id)         ON DELETE SET NULL,
        INDEX idx_vr_registration (registration_id),
        INDEX idx_vr_status (status)
      ) ENGINE=InnoDB
    `);

    const evidencePhoto = req.file ? '/uploads/evidence/' + req.file.filename : null;

    // Save as pending report — NOT into violations table yet
    await conn.query(
      `INSERT INTO violation_reports
         (registration_id, rule_id, description, evidence_photo, reported_by, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [registrationId, ruleId, description || null, evidencePhoto, req.session.admin.id]
    );

    req.flash('success', '📋 แจ้งรายการกระทำผิดเรียบร้อยแล้ว — รอการตรวจสอบและยืนยันจากผู้ดูแลระบบก่อนจึงจะบันทึกลงประวัติ');
    res.redirect('/violations');
  } catch (err) {
    console.error('POST /violations error:', err);
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'เกิดข้อผิดพลาด: ' + err.message);
    res.redirect('/violations/create?reg_id=' + (req.body.registration_id || ''));
  } finally {
    if (conn) conn.release();
  }
});

// POST /violations/:id/edit
router.post('/:id/edit', isHead, upload.single('evidence_photo'), verifyCsrf, async (req, res) => {
  const violationId = parseInt(req.params.id, 10);
  const ruleId = parseInt(req.body.rule_id, 10);
  const description = (req.body.description || '').trim() || null;
  const recordedAtRaw = (req.body.recorded_at || '').trim();
  const returnTo = Number.isFinite(violationId) && violationId > 0 ? `/violations/${violationId}` : '/violations';

  if (!Number.isFinite(violationId) || violationId <= 0) {
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'ข้อมูลรายการแจ้งไม่ถูกต้อง');
    return res.redirect('/violations');
  }

  if (!Number.isFinite(ruleId) || ruleId <= 0) {
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'กรุณาเลือกกฎที่กระทำผิด');
    return res.redirect(returnTo);
  }

  if (!isValidDatetimeLocal(recordedAtRaw)) {
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'กรุณาระบุวันที่บันทึกให้ถูกต้อง');
    return res.redirect(returnTo);
  }

  let conn;
  try {
    conn = await pool.getConnection();

    const [violation] = await conn.query(
      `SELECT id, registration_id
       FROM violations
       WHERE id = ?`,
      [violationId]
    );

    if (!violation) {
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'ไม่พบรายการแจ้งที่ต้องการแก้ไข');
      return res.redirect('/violations');
    }

    const [rule] = await conn.query(
      'SELECT id FROM rules WHERE id = ?',
      [ruleId]
    );

    if (!rule) {
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'ไม่พบกฎที่เลือก');
      return res.redirect(returnTo);
    }

    let sql = `UPDATE violations
       SET rule_id = ?, description = ?, recorded_at = ?`;
    const params = [ruleId, description, toSqlDatetime(recordedAtRaw)];

    if (req.file) {
      sql += ', evidence_photo = ?';
      params.push('/uploads/evidence/' + req.file.filename);
    }

    sql += ' WHERE id = ?';
    params.push(violationId);

    await conn.query(sql, params);

    try {
      let reportSql = 'UPDATE violation_reports SET rule_id = ?, description = ?';
      const reportParams = [ruleId, description];

      if (req.file) {
        reportSql += ', evidence_photo = ?';
        reportParams.push('/uploads/evidence/' + req.file.filename);
      }

      reportSql += ' WHERE violation_id = ?';
      reportParams.push(violationId);
      await conn.query(reportSql, reportParams);
    } catch (updateReportErr) {
      if (!['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(updateReportErr.code)) throw updateReportErr;
    }

    req.flash('success', 'แก้ไขรายการแจ้งเรียบร้อยแล้ว');
    return res.redirect(returnTo);
  } catch (err) {
    console.error('POST /violations/:id/edit error:', err);
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'ไม่สามารถแก้ไขรายการแจ้งได้: ' + err.message);
    return res.redirect(returnTo);
  } finally {
    if (conn) conn.release();
  }
});

// POST /violations/:id/delete
router.post('/:id/delete', isHead, verifyCsrf, async (req, res) => {
  const violationId = parseInt(req.params.id, 10);

  if (!Number.isFinite(violationId) || violationId <= 0) {
    req.flash('error', 'ข้อมูลรายการแจ้งไม่ถูกต้อง');
    return res.redirect('/violations');
  }

  let conn;
  try {
    conn = await pool.getConnection();

    const [violation] = await conn.query(
      `SELECT id, registration_id
       FROM violations
       WHERE id = ?`,
      [violationId]
    );

    if (!violation) {
      req.flash('error', 'ไม่พบรายการแจ้งที่ต้องการลบ');
      return res.redirect('/violations');
    }

    try {
      await conn.query(
        'UPDATE violation_reports SET violation_id = NULL WHERE violation_id = ?',
        [violationId]
      );
    } catch (updateReportErr) {
      if (!['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(updateReportErr.code)) throw updateReportErr;
    }

    await conn.query('DELETE FROM violations WHERE id = ?', [violationId]);

    req.flash('success', 'ลบรายการแจ้งเรียบร้อยแล้ว');
    return res.redirect(`/registrations/${violation.registration_id}#violations`);
  } catch (err) {
    console.error('POST /violations/:id/delete error:', err);
    req.flash('error', 'ไม่สามารถลบรายการแจ้งได้: ' + err.message);
    return res.redirect(`/violations/${violationId}`);
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
