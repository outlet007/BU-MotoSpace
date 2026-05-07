const router = require('express').Router();
const pool = require('../config/database');
const upload = require('../middleware/upload');
const { isAuthenticated, isHead } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/csrf');

router.use(isAuthenticated);

function suggestViolationTypeCode(typeName) {
  const name = String(typeName || '').toLowerCase();
  if (name.includes('\u0e40\u0e25\u0e47\u0e01\u0e19\u0e49\u0e2d\u0e22') || name.includes('minor') || name.includes('min')) return 'MIN';
  if (name.includes('\u0e1b\u0e32\u0e19\u0e01\u0e25\u0e32\u0e07') || name.includes('major') || name.includes('maj')) return 'MAJ';
  if (name.includes('\u0e23\u0e49\u0e32\u0e22\u0e41\u0e23\u0e07') || name.includes('critical') || name.includes('cri')) return 'CRI';
  return null;
}

async function ensureViolationTypeMetadata(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS violation_types (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type_name VARCHAR(200) NOT NULL UNIQUE,
      type_code VARCHAR(20) DEFAULT NULL,
      max_violations INT NOT NULL DEFAULT 3,
      is_active BOOLEAN DEFAULT TRUE,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_violation_type_code (type_code),
      FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  const [column] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'violation_types'
       AND COLUMN_NAME = 'type_code'`
  );

  if (parseInt(column.cnt, 10) === 0) {
    await conn.query('ALTER TABLE violation_types ADD COLUMN type_code VARCHAR(20) DEFAULT NULL AFTER type_name');
  }

  const [index] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'violation_types'
       AND INDEX_NAME = 'uq_violation_type_code'`
  );

  if (parseInt(index.cnt, 10) === 0) {
    await conn.query('ALTER TABLE violation_types ADD UNIQUE INDEX uq_violation_type_code (type_code)');
  }

  const [ruleColumn] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'rules'
       AND COLUMN_NAME = 'violation_type_id'`
  );

  if (parseInt(ruleColumn.cnt, 10) === 0) {
    await conn.query('ALTER TABLE rules ADD COLUMN violation_type_id INT DEFAULT NULL AFTER description');
  }

  const [ruleIndex] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'rules'
       AND INDEX_NAME = 'idx_rules_violation_type'`
  );

  if (parseInt(ruleIndex.cnt, 10) === 0) {
    await conn.query('ALTER TABLE rules ADD INDEX idx_rules_violation_type (violation_type_id)');
  }

  const existingRows = await conn.query(
    `SELECT UPPER(type_code) AS type_code
     FROM violation_types
     WHERE type_code IS NOT NULL AND TRIM(type_code) <> ''`
  );
  const usedCodes = new Set(existingRows.map(row => row.type_code));

  const missingRows = await conn.query(
    `SELECT id, type_name
     FROM violation_types
     WHERE type_code IS NULL OR TRIM(type_code) = ''`
  );

  for (const row of missingRows) {
    const code = suggestViolationTypeCode(row.type_name);
    if (!code || usedCodes.has(code)) continue;
    await conn.query('UPDATE violation_types SET type_code = ? WHERE id = ?', [code, row.id]);
    usedCodes.add(code);
  }

  const [unassigned] = await conn.query(
    'SELECT COUNT(*) AS cnt FROM rules WHERE violation_type_id IS NULL'
  );

  if (parseInt(unassigned.cnt, 10) > 0) {
    const typeRows = await conn.query(
      'SELECT id, max_violations FROM violation_types ORDER BY is_active DESC, id ASC'
    );

    for (const type of typeRows) {
      await conn.query(
        `UPDATE rules
         SET violation_type_id = ?
         WHERE violation_type_id IS NULL AND max_violations = ?`,
        [type.id, type.max_violations]
      );
    }

    if (typeRows.length > 0) {
      await conn.query(
        `UPDATE rules
         SET violation_type_id = ?
         WHERE violation_type_id IS NULL`,
        [typeRows[0].id]
      );
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Ensure the violation_reports table exists (lazy migration)
   ───────────────────────────────────────────────────────────────────────────── */
async function ensureTable(conn) {
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
      FOREIGN KEY (violation_id)    REFERENCES violations(id)     ON DELETE SET NULL,
      INDEX idx_vr_registration (registration_id),
      INDEX idx_vr_status (status)
    ) ENGINE=InnoDB
  `);

  await ensureViolationTypeMetadata(conn);
}

/* ─────────────────────────────────────────────────────────────────────────────
   GET /violation-reports  —  list all reports
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureTable(conn);

    const {
      search = '',
      status_filter = 'pending',
      violation_type_filter = 'all',
      page = 1,
    } = req.query;
    const limit = 20;
    const offset = (parseInt(page) - 1) * limit;
    const requestedViolationType = String(violation_type_filter || 'all').trim();
    const selectedViolationType = requestedViolationType === 'all' || /^\d+$/.test(requestedViolationType)
      ? requestedViolationType
      : 'all';

    let where = 'WHERE 1=1';
    const params = [];

    if (status_filter && status_filter !== 'all') {
      where += ' AND vr.status = ?';
      params.push(status_filter);
    }

    if (selectedViolationType && selectedViolationType !== 'all') {
      where += ' AND ru.violation_type_id = ?';
      params.push(parseInt(selectedViolationType, 10));
    }

    if (search) {
      const s = `%${search.trim()}%`;
      where += ` AND (
        CONCAT('IR-', COALESCE(NULLIF(vt.type_code, ''), 'GEN'), '-', LPAD(vr.id, 6, '0')) LIKE ? OR
        r.id_number LIKE ? OR
        r.first_name LIKE ? OR
        r.last_name LIKE ? OR
        CONCAT(r.first_name,' ',r.last_name) LIKE ? OR
        r.license_plate LIKE ? OR
        ru.rule_name LIKE ?
      )`;
      params.push(s, s, s, s, s, s, s);
    }

    const [countRow] = await conn.query(
      `SELECT COUNT(*) as cnt
       FROM violation_reports vr
       JOIN registrations r ON vr.registration_id = r.id
       JOIN rules ru ON vr.rule_id = ru.id
       LEFT JOIN violation_types vt ON ru.violation_type_id = vt.id
       ${where}`,
      params
    );
    const total = parseInt(countRow.cnt);
    const totalPages = Math.ceil(total / limit);

    const reports = await conn.query(
      `SELECT vr.id, vr.status, vr.reported_at, vr.description,
              CONCAT('IR-', COALESCE(NULLIF(vt.type_code, ''), 'GEN'), '-', LPAD(vr.id, 6, '0')) AS report_code,
              r.id_number, r.first_name, r.last_name, r.license_plate, r.user_type,
              ru.rule_name,
              a.full_name AS reported_by_name
       FROM violation_reports vr
       JOIN registrations r  ON vr.registration_id = r.id
       JOIN rules ru          ON vr.rule_id          = ru.id
       LEFT JOIN violation_types vt ON ru.violation_type_id = vt.id
       JOIN admins a          ON vr.reported_by       = a.id
       ${where}
       ORDER BY vr.reported_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Pending count badge
    const [pendingRow] = await conn.query(
      `SELECT COUNT(*) as cnt FROM violation_reports WHERE status = 'pending'`
    );
    const violationTypes = await conn.query(
      `SELECT id, type_name, type_code, is_active
       FROM violation_types
       ORDER BY is_active DESC, type_code IS NULL, type_code ASC, type_name ASC`
    );

    res.render('violation-reports/index', {
      title: 'ตรวจสอบการกระทำผิดกฎ - BU MotoSpace',
      reports,
      total,
      totalPages,
      currentPage: parseInt(page),
      search,
      status_filter,
      violation_type_filter: selectedViolationType,
      violationTypes,
      pendingReportsCount: parseInt(pendingRow.cnt),
    });
  } catch (err) {
    console.error('GET /violation-reports error:', err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลได้: ' + err.message);
    res.render('violation-reports/index', {
      title: 'ตรวจสอบการกระทำผิดกฎ - BU MotoSpace',
      reports: [],
      total: 0,
      totalPages: 0,
      currentPage: 1,
      search: '',
      status_filter: 'pending',
      violation_type_filter: 'all',
      violationTypes: [],
      pendingReportsCount: 0,
    });
  } finally {
    if (conn) conn.release();
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /violation-reports/:id  —  detail
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/:id', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureTable(conn);

    const [report] = await conn.query(
      `SELECT vr.*,
              CONCAT('IR-', COALESCE(NULLIF(vt.type_code, ''), 'GEN'), '-', LPAD(vr.id, 6, '0')) AS report_code,
              r.id_number, r.user_type, r.first_name, r.last_name, r.license_plate,
              r.province, r.phone, r.motorcycle_photo, r.plate_photo, r.id_card_photo,
              ru.rule_name, ru.description AS rule_desc, ru.max_violations, ru.penalty,
              a.full_name AS reported_by_name,
              a.email     AS reported_by_email,
              a.phone     AS reported_by_phone,
              rv.full_name AS reviewed_by_name
       FROM violation_reports vr
       JOIN registrations r  ON vr.registration_id = r.id
       JOIN rules ru          ON vr.rule_id          = ru.id
       LEFT JOIN violation_types vt ON ru.violation_type_id = vt.id
       JOIN admins a          ON vr.reported_by       = a.id
       LEFT JOIN admins rv    ON vr.reviewed_by       = rv.id
       WHERE vr.id = ?`,
      [req.params.id]
    );

    if (!report) {
      req.flash('error', 'ไม่พบรายการที่ต้องการ');
      return res.redirect('/violation-reports');
    }

    // Find the violation_type_id for this rule
    let ruleViolationTypeId = null;
    try {
      const [ruleRow] = await conn.query(
        `SELECT violation_type_id FROM rules WHERE id = ?`,
        [report.rule_id]
      );
      ruleViolationTypeId = ruleRow && ruleRow.violation_type_id ? ruleRow.violation_type_id : null;
    } catch (e) { /* ignore */ }

    let latestResetAt = '1000-01-01 00:00:00';
    try {
      // Type-specific reset
      if (ruleViolationTypeId) {
        const [typeReset] = await conn.query(
          `SELECT MAX(created_at) as latest_reset_at FROM summons_appointments WHERE registration_id = ? AND violation_type_id = ?`,
          [report.registration_id, ruleViolationTypeId]
        );
        if (typeReset && typeReset.latest_reset_at) {
          latestResetAt = typeReset.latest_reset_at;
        }
      }
      // Legacy global reset (where violation_type_id IS NULL)
      const [globalReset] = await conn.query(
        `SELECT MAX(created_at) as latest_reset_at FROM summons_appointments WHERE registration_id = ? AND violation_type_id IS NULL`,
        [report.registration_id]
      );
      if (globalReset && globalReset.latest_reset_at && globalReset.latest_reset_at > latestResetAt) {
        latestResetAt = globalReset.latest_reset_at;
      }
    } catch (e) {
      // ignore
    }

    // How many confirmed violations already exist for this person+rule
    const [vioCount] = await conn.query(
      `SELECT COUNT(*) as cnt FROM violations WHERE registration_id = ? AND rule_id = ? AND recorded_at > ?`,
      [report.registration_id, report.rule_id, latestResetAt]
    );

    res.render('violation-reports/detail', {
      title: `ตรวจสอบรายการ ${report.report_code} - BU MotoSpace`,
      r: report,
      existingViolationCount: parseInt(vioCount.cnt),
    });
  } catch (err) {
    console.error('GET /violation-reports/:id error:', err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลได้');
    res.redirect('/violation-reports');
  } finally {
    if (conn) conn.release();
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /violation-reports  —  submit a new report
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/', upload.single('evidence_photo'), verifyCsrf, async (req, res) => {
  const registrationId = parseInt(req.body.registration_id, 10);
  const ruleId = parseInt(req.body.rule_id, 10);
  const { description } = req.body;

  if (!Number.isFinite(registrationId) || registrationId <= 0 || !Number.isFinite(ruleId) || ruleId <= 0) {
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'กรุณาเลือกผู้ลงทะเบียนและกฎที่กระทำผิดให้ถูกต้อง');
    return res.redirect('/violations');
  }
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureTable(conn);

    const evidencePhoto = req.file ? '/uploads/evidence/' + req.file.filename : null;

    await conn.query(
      `INSERT INTO violation_reports
         (registration_id, rule_id, description, evidence_photo, reported_by, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [registrationId, ruleId, description || null, evidencePhoto, req.session.admin.id]
    );

    req.flash('success', 'แจ้งรายการกระทำผิดเรียบร้อยแล้ว รอการตรวจสอบจากผู้ดูแลระบบ');
    res.redirect('/violations');
  } catch (err) {
    console.error('POST /violation-reports error:', err);
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'เกิดข้อผิดพลาด: ' + err.message);
    res.redirect('/violations');
  } finally {
    if (conn) conn.release();
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /violation-reports/:id/confirm  —  confirm → write to violations table
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/:id/confirm', isHead, async (req, res) => {
  let conn;
  let transactionStarted = false;
  try {
    conn = await pool.getConnection();
    await ensureTable(conn);
    await conn.beginTransaction();
    transactionStarted = true;

    const [report] = await conn.query(
      `SELECT vr.*, ru.max_violations, ru.rule_name, ru.penalty
       FROM violation_reports vr
       JOIN rules ru ON vr.rule_id = ru.id
       WHERE vr.id = ? AND vr.status = 'pending'
       FOR UPDATE`,
      [req.params.id]
    );

    if (!report) {
      await conn.rollback();
      transactionStarted = false;
      req.flash('error', 'ไม่พบรายการหรือรายการนี้ถูกดำเนินการแล้ว');
      return res.redirect('/violation-reports');
    }

    // Find the violation_type_id for this rule
    let ruleViolationTypeId = null;
    try {
      const [ruleRow] = await conn.query(
        `SELECT violation_type_id FROM rules WHERE id = ?`,
        [report.rule_id]
      );
      ruleViolationTypeId = ruleRow && ruleRow.violation_type_id ? ruleRow.violation_type_id : null;
    } catch (e) { /* ignore */ }

    let latestResetAt = '1000-01-01 00:00:00';
    try {
      // Type-specific reset
      if (ruleViolationTypeId) {
        const [typeReset] = await conn.query(
          `SELECT MAX(created_at) as latest_reset_at FROM summons_appointments WHERE registration_id = ? AND violation_type_id = ?`,
          [report.registration_id, ruleViolationTypeId]
        );
        if (typeReset && typeReset.latest_reset_at) {
          latestResetAt = typeReset.latest_reset_at;
        }
      }
      // Legacy global reset (where violation_type_id IS NULL)
      const [globalReset] = await conn.query(
        `SELECT MAX(created_at) as latest_reset_at FROM summons_appointments WHERE registration_id = ? AND violation_type_id IS NULL`,
        [report.registration_id]
      );
      if (globalReset && globalReset.latest_reset_at && globalReset.latest_reset_at > latestResetAt) {
        latestResetAt = globalReset.latest_reset_at;
      }
    } catch (e) {
      // ignore
    }

    // Check violation limit
    const existingViolations = await conn.query(
      `SELECT id
       FROM violations
       WHERE registration_id = ? AND rule_id = ? AND recorded_at > ?
       FOR UPDATE`,
      [report.registration_id, report.rule_id, latestResetAt]
    );
    const currentCount = existingViolations.length;

    if (currentCount >= report.max_violations) {
      await conn.rollback();
      transactionStarted = false;
      req.flash('error', `ผู้นี้ครบจำนวนครั้งที่กำหนด (${report.max_violations} ครั้ง) สำหรับกฎ "${report.rule_name}" แล้ว`);
      return res.redirect(`/violation-reports/${req.params.id}`);
    }

    // Insert into violations table
    const result = await conn.query(
      `INSERT INTO violations
         (registration_id, rule_id, description, evidence_photo, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [report.registration_id, report.rule_id, report.description, report.evidence_photo, req.session.admin.id]
    );

    const newViolationId = result.insertId;

    // Update report status
    const updateResult = await conn.query(
      `UPDATE violation_reports
       SET status = 'confirmed', reviewed_by = ?, reviewed_at = NOW(), violation_id = ?
       WHERE id = ? AND status = 'pending'`,
      [req.session.admin.id, newViolationId, req.params.id]
    );

    if (!updateResult.affectedRows) {
      throw new Error('Report was already processed');
    }

    await conn.commit();
    transactionStarted = false;

    const remaining = report.max_violations - currentCount - 1;
    if (remaining <= 0) {
      req.flash('warning', `⚠️ ยืนยันแล้ว — ผู้นี้ครบจำนวนครั้งที่กำหนดแล้ว บทลงโทษ: ${report.penalty || 'ไม่ระบุ'}`);
    } else {
      req.flash('success', `✅ ยืนยันการกระทำผิดเรียบร้อย บันทึกลงประวัติแล้ว (เหลือโอกาสอีก ${remaining} ครั้ง)`);
    }

    res.redirect('/violation-reports');
  } catch (err) {
    if (transactionStarted && conn) {
      try { await conn.rollback(); } catch (rollbackErr) { console.error('Rollback failed:', rollbackErr); }
    }
    console.error('POST /violation-reports/:id/confirm error:', err);
    req.flash('error', 'เกิดข้อผิดพลาด: ' + err.message);
    res.redirect(`/violation-reports/${req.params.id}`);
  } finally {
    if (conn) conn.release();
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /violation-reports/:id/reject  —  reject report
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/:id/reject', isHead, async (req, res) => {
  const { review_note } = req.body;
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureTable(conn);

    const [report] = await conn.query(
      `SELECT id, status FROM violation_reports WHERE id = ?`,
      [req.params.id]
    );

    if (!report || report.status !== 'pending') {
      req.flash('error', 'ไม่พบรายการหรือรายการนี้ถูกดำเนินการแล้ว');
      return res.redirect('/violation-reports');
    }

    await conn.query(
      `UPDATE violation_reports
       SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), review_note = ?
       WHERE id = ?`,
      [req.session.admin.id, review_note || null, req.params.id]
    );

    req.flash('success', 'ปฏิเสธรายการกระทำผิดเรียบร้อยแล้ว');
    res.redirect('/violation-reports');
  } catch (err) {
    console.error('POST /violation-reports/:id/reject error:', err);
    req.flash('error', 'เกิดข้อผิดพลาด: ' + err.message);
    res.redirect(`/violation-reports/${req.params.id}`);
  } finally {
    if (conn) conn.release();
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /violation-reports/:id/edit  —  edit a pending report then re-confirm
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/:id/edit', isHead, async (req, res) => {
  const { description, rule_id } = req.body;
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureTable(conn);

    await conn.query(
      `UPDATE violation_reports
       SET description = ?, rule_id = ?
       WHERE id = ? AND status = 'pending'`,
      [description || null, rule_id, req.params.id]
    );

    req.flash('success', 'แก้ไขรายการเรียบร้อยแล้ว');
    res.redirect(`/violation-reports/${req.params.id}`);
  } catch (err) {
    console.error('POST /violation-reports/:id/edit error:', err);
    req.flash('error', 'เกิดข้อผิดพลาด: ' + err.message);
    res.redirect(`/violation-reports/${req.params.id}`);
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
