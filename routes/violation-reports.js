const router = require('express').Router();
const pool = require('../config/database');
const upload = require('../middleware/upload');
const { isAuthenticated, isHead } = require('../middleware/auth');

router.use(isAuthenticated);

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
}

/* ─────────────────────────────────────────────────────────────────────────────
   GET /violation-reports  —  list all reports
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureTable(conn);

    const { search = '', status_filter = 'pending', page = 1 } = req.query;
    const limit = 20;
    const offset = (parseInt(page) - 1) * limit;

    let where = 'WHERE 1=1';
    const params = [];

    if (status_filter && status_filter !== 'all') {
      where += ' AND vr.status = ?';
      params.push(status_filter);
    }

    if (search) {
      const s = `%${search.trim()}%`;
      where += ` AND (
        r.id_number LIKE ? OR
        r.first_name LIKE ? OR
        r.last_name LIKE ? OR
        CONCAT(r.first_name,' ',r.last_name) LIKE ? OR
        r.license_plate LIKE ? OR
        ru.rule_name LIKE ?
      )`;
      params.push(s, s, s, s, s, s);
    }

    const [countRow] = await conn.query(
      `SELECT COUNT(*) as cnt
       FROM violation_reports vr
       JOIN registrations r ON vr.registration_id = r.id
       JOIN rules ru ON vr.rule_id = ru.id
       ${where}`,
      params
    );
    const total = parseInt(countRow.cnt);
    const totalPages = Math.ceil(total / limit);

    const reports = await conn.query(
      `SELECT vr.id, vr.status, vr.reported_at, vr.description,
              r.id_number, r.first_name, r.last_name, r.license_plate, r.user_type,
              ru.rule_name,
              a.full_name AS reported_by_name
       FROM violation_reports vr
       JOIN registrations r  ON vr.registration_id = r.id
       JOIN rules ru          ON vr.rule_id          = ru.id
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

    res.render('violation-reports/index', {
      title: 'ตรวจสอบการกระทำผิดกฎ - BU MotoSpace',
      reports,
      total,
      totalPages,
      currentPage: parseInt(page),
      search,
      status_filter,
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
       JOIN admins a          ON vr.reported_by       = a.id
       LEFT JOIN admins rv    ON vr.reviewed_by       = rv.id
       WHERE vr.id = ?`,
      [req.params.id]
    );

    if (!report) {
      req.flash('error', 'ไม่พบรายการที่ต้องการ');
      return res.redirect('/violation-reports');
    }

    // How many confirmed violations already exist for this person+rule
    const [vioCount] = await conn.query(
      `SELECT COUNT(*) as cnt FROM violations WHERE registration_id = ? AND rule_id = ?`,
      [report.registration_id, report.rule_id]
    );

    res.render('violation-reports/detail', {
      title: `ตรวจสอบรายการ #${report.id} - BU MotoSpace`,
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
router.post('/', upload.single('evidence_photo'), async (req, res) => {
  const { registration_id, rule_id, description } = req.body;
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureTable(conn);

    const evidencePhoto = req.file ? '/uploads/evidence/' + req.file.filename : null;

    await conn.query(
      `INSERT INTO violation_reports
         (registration_id, rule_id, description, evidence_photo, reported_by, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [registration_id, rule_id, description || null, evidencePhoto, req.session.admin.id]
    );

    req.flash('success', 'แจ้งรายการกระทำผิดเรียบร้อยแล้ว รอการตรวจสอบจากผู้ดูแลระบบ');
    res.redirect('/violations');
  } catch (err) {
    console.error('POST /violation-reports error:', err);
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
  try {
    conn = await pool.getConnection();
    await ensureTable(conn);

    const [report] = await conn.query(
      `SELECT vr.*, ru.max_violations, ru.rule_name, ru.penalty
       FROM violation_reports vr
       JOIN rules ru ON vr.rule_id = ru.id
       WHERE vr.id = ?`,
      [req.params.id]
    );

    if (!report || report.status !== 'pending') {
      req.flash('error', 'ไม่พบรายการหรือรายการนี้ถูกดำเนินการแล้ว');
      return res.redirect('/violation-reports');
    }

    // Check violation limit
    const [countResult] = await conn.query(
      `SELECT COUNT(*) as cnt FROM violations WHERE registration_id = ? AND rule_id = ?`,
      [report.registration_id, report.rule_id]
    );
    const currentCount = parseInt(countResult.cnt);

    if (currentCount >= report.max_violations) {
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
    await conn.query(
      `UPDATE violation_reports
       SET status = 'confirmed', reviewed_by = ?, reviewed_at = NOW(), violation_id = ?
       WHERE id = ?`,
      [req.session.admin.id, newViolationId, req.params.id]
    );

    const remaining = report.max_violations - currentCount - 1;
    if (remaining <= 0) {
      req.flash('warning', `⚠️ ยืนยันแล้ว — ผู้นี้ครบจำนวนครั้งที่กำหนดแล้ว บทลงโทษ: ${report.penalty || 'ไม่ระบุ'}`);
    } else {
      req.flash('success', `✅ ยืนยันการกระทำผิดเรียบร้อย บันทึกลงประวัติแล้ว (เหลือโอกาสอีก ${remaining} ครั้ง)`);
    }

    res.redirect('/violation-reports');
  } catch (err) {
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
