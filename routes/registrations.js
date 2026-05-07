const router = require('express').Router();
const pool = require('../config/database');
const upload = require('../middleware/upload');
const { isAuthenticated, isHead } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/csrf');
const { generateHash, compareHashes } = require('../utils/imageHash');

router.use(isAuthenticated);

async function ensureSummonsAppointmentColumn(conn, columnName, definition) {
  const [column] = await conn.query(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'summons_appointments'
       AND COLUMN_NAME = ?`,
    [columnName]
  );

  if (!column) {
    await conn.query(`ALTER TABLE summons_appointments ADD COLUMN ${columnName} ${definition}`);
  }
}

async function ensureSummonsAppointmentIndex(conn, indexName, definition) {
  const [index] = await conn.query(
    `SELECT INDEX_NAME
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'summons_appointments'
       AND INDEX_NAME = ?`,
    [indexName]
  );

  if (!index) {
    await conn.query(`ALTER TABLE summons_appointments ADD ${definition}`);
  }
}

async function ensureSummonsAppointmentsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS summons_appointments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      appointment_code VARCHAR(30) DEFAULT NULL,
      registration_id INT NOT NULL,
      scheduled_at DATETIME NOT NULL,
      note TEXT,
      written_document VARCHAR(500) DEFAULT NULL,
      written_document_original_name VARCHAR(255) DEFAULT NULL,
      summoned_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (registration_id) REFERENCES registrations(id) ON DELETE CASCADE,
      FOREIGN KEY (summoned_by) REFERENCES admins(id) ON DELETE CASCADE,
      UNIQUE KEY uq_summons_appointment_code (appointment_code),
      INDEX idx_registration_created (registration_id, created_at),
      INDEX idx_scheduled_at (scheduled_at)
    ) ENGINE=InnoDB
  `);
  await ensureSummonsAppointmentColumn(conn, 'appointment_code', 'VARCHAR(30) DEFAULT NULL AFTER id');
  await ensureSummonsAppointmentColumn(conn, 'written_document', 'VARCHAR(500) DEFAULT NULL');
  await ensureSummonsAppointmentColumn(conn, 'written_document_original_name', 'VARCHAR(255) DEFAULT NULL');
  await ensureSummonsAppointmentIndex(conn, 'uq_summons_appointment_code', 'UNIQUE INDEX uq_summons_appointment_code (appointment_code)');
}

function isValidDatetimeLocal(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '');
}

function toSqlDatetime(datetimeLocal) {
  return datetimeLocal.replace('T', ' ') + ':00';
}

// GET /registrations
router.get('/', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const { search, type, status, page = 1 } = req.query;
    const limit = 20;
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    const params = [];

    if (search) {
      // Normalize: trim and collapse multiple spaces for reliable matching
      const searchTrimmed = search.trim().replace(/\s+/g, ' ');
      const s = `%${searchTrimmed}%`;
      // Also search by combined full name (first_name + space + last_name)
      const sName = `%${searchTrimmed}%`;
      where += ` AND (
        id_number LIKE ? OR
        first_name LIKE ? OR
        last_name LIKE ? OR
        CONCAT(first_name, ' ', last_name) LIKE ? OR
        license_plate LIKE ? OR
        REPLACE(license_plate, ' ', '') LIKE ? OR
        phone LIKE ?
      )`;
      const sNoSpace = `%${searchTrimmed.replace(/\s+/g, '')}%`;
      params.push(s, s, s, sName, s, sNoSpace, s);
    }
    if (type) { where += ' AND user_type = ?'; params.push(type); }
    if (status) { where += ' AND status = ?'; params.push(status); }

    const [countResult] = await conn.query(`SELECT COUNT(*) as cnt FROM registrations ${where}`, params);
    const total = parseInt(countResult.cnt);
    const totalPages = Math.ceil(total / limit);

    const rows = await conn.query(
      `SELECT id, id_number, user_type, first_name, last_name, phone, license_plate, province, status, registered_at
       FROM registrations ${where} ORDER BY registered_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Pick up image search results from session (set by POST /search)
    const imageSearchResults = req.session.imageSearchResults || null;
    if (req.session.imageSearchResults) delete req.session.imageSearchResults;

    const pageTitle = status === 'pending' ? 'ตรวจสอบการลงทะเบียนใหม่' : 'จัดการทะเบียน';

    res.render('registrations/index', {
      title: `${pageTitle} - BU MotoSpace`,
      registrations: rows,
      total,
      totalPages,
      currentPage: parseInt(page),
      search: search || '',
      type: type || '',
      status: status || '',
      imageSearchResults,
    });
  } catch (err) {
    console.error('GET /registrations error:', err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลได้: ' + err.message);
    // Render page with empty data instead of redirecting
    const pageTitle = req.query.status === 'pending' ? 'ตรวจสอบการลงทะเบียนใหม่' : 'จัดการทะเบียน';

    return res.render('registrations/index', {
      title: `${pageTitle} - BU MotoSpace`,
      registrations: [],
      total: 0,
      totalPages: 0,
      currentPage: 1,
      search: req.query.search || '',
      type: req.query.type || '',
      status: req.query.status || '',
      imageSearchResults: null,
    });
  } finally {
    if (conn) conn.release();
  }
});

// POST /registrations/search — Process image search (called from modal)
router.post('/search', upload.single('search_image'), verifyCsrf, async (req, res) => {
  let conn;
  try {
    if (!req.file) {
      req.flash('error', 'กรุณาอัพโหลดภาพ');
      return res.redirect('/registrations');
    }

    const searchHash = await generateHash(req.file.path);
    if (!searchHash) {
      req.flash('error', 'ไม่สามารถประมวลผลภาพได้');
      return res.redirect('/registrations');
    }

    conn = await pool.getConnection();
    const hashes = await conn.query(
      `SELECT ih.*, r.id as reg_id, r.first_name, r.last_name, r.license_plate, r.id_number, r.user_type, r.phone, r.motorcycle_photo, r.plate_photo
       FROM image_hashes ih
       JOIN registrations r ON ih.registration_id = r.id`
    );

    const results = [];
    for (const h of hashes) {
      const similarity = 1 - compareHashes(searchHash, h.phash);
      if (similarity > 0.7) {  // 70% match threshold
        results.push({
          ...h,
          similarity: Math.round(similarity * 100),
        });
      }
    }
    results.sort((a, b) => b.similarity - a.similarity);

    // Redirect to registrations list with search results in flash or session
    req.session.imageSearchResults = {
      results,
      searchImage: '/uploads/temp/' + req.file.filename,
    };
    if (req.headers.referer && req.headers.referer.includes('/violations')) {
      return res.redirect('/violations?imageSearch=1');
    }
    res.redirect('/registrations?imageSearch=1');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
    if (req.headers.referer && req.headers.referer.includes('/violations')) {
      return res.redirect('/violations');
    }
    res.redirect('/registrations');
  } finally {
    if (conn) conn.release();
  }
});

// GET /registrations/api/search — AJAX JSON search (for live search / autocomplete)
router.get('/api/search', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const { q } = req.query;
    if (!q || !q.trim()) return res.json([]);

    const searchTrimmed = q.trim().replace(/\s+/g, ' ');
    const s = `%${searchTrimmed}%`;
    const sNoSpace = `%${searchTrimmed.replace(/\s+/g, '')}%`;

    const rows = await conn.query(
      `SELECT id, id_number, user_type, first_name, last_name, phone, license_plate, province, status
       FROM registrations
       WHERE (
         id_number LIKE ? OR
         first_name LIKE ? OR
         last_name LIKE ? OR
         CONCAT(first_name, ' ', last_name) LIKE ? OR
         license_plate LIKE ? OR
         REPLACE(license_plate, ' ', '') LIKE ? OR
         phone LIKE ?
       )
       ORDER BY registered_at DESC LIMIT 10`,
      [s, s, s, s, s, sNoSpace, s]
    );
    return res.json(rows);
  } catch (err) {
    console.error('AJAX search error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (conn) conn.release();
  }
});

// GET /registrations/:id

router.get('/:id', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [reg] = await conn.query('SELECT * FROM registrations WHERE id = ?', [req.params.id]);
    if (!reg) {
      req.flash('error', 'ไม่พบข้อมูล');
      return res.redirect('/registrations');
    }

    const violations = await conn.query(
      `SELECT v.*,
              DATE_FORMAT(v.recorded_at, '%Y-%m-%dT%H:%i') AS recorded_at_input,
              CONCAT('IR-', COALESCE(NULLIF(vt.type_code, ''), 'GEN'), '-', LPAD(v.id, 6, '0')) AS incident_code,
              ru.rule_name, ru.max_violations,
              COALESCE(vt.type_name, ru.rule_name) AS violation_type_name,
              a.full_name as recorded_by_name,
              rpa.full_name as reported_by_name
       FROM violations v
       JOIN rules ru ON v.rule_id = ru.id
       LEFT JOIN violation_types vt ON ru.violation_type_id = vt.id
       JOIN admins a ON v.recorded_by = a.id
       LEFT JOIN violation_reports vr ON vr.violation_id = v.id
       LEFT JOIN admins rpa ON vr.reported_by = rpa.id
       WHERE v.registration_id = ?
       ORDER BY v.recorded_at DESC`,
      [req.params.id]
    );

    // Count violations per rule
    const violationCounts = await conn.query(
      `SELECT COALESCE(ru.violation_type_id, ru.id) AS type_group_id,
              COALESCE(vt.type_name, ru.rule_name) AS rule_name,
              COALESCE(vt.max_violations, ru.max_violations) AS max_violations,
              COUNT(*) as cnt
       FROM violations v
       JOIN rules ru ON v.rule_id = ru.id
       LEFT JOIN violation_types vt ON ru.violation_type_id = vt.id
       LEFT JOIN (
         SELECT registration_id, violation_type_id, MAX(created_at) AS latest_reset_at
         FROM summons_appointments
         WHERE violation_type_id IS NOT NULL
         GROUP BY registration_id, violation_type_id
       ) sa_type ON sa_type.registration_id = v.registration_id
                 AND sa_type.violation_type_id = ru.violation_type_id
       LEFT JOIN (
         SELECT registration_id, MAX(created_at) AS latest_reset_at
         FROM summons_appointments
         WHERE violation_type_id IS NULL
         GROUP BY registration_id
       ) sa_global ON sa_global.registration_id = v.registration_id
       WHERE v.registration_id = ?
         AND v.recorded_at > COALESCE(
           GREATEST(
             COALESCE(sa_type.latest_reset_at, '1000-01-01'),
             COALESCE(sa_global.latest_reset_at, '1000-01-01')
           ),
           '1000-01-01 00:00:00'
         )
       GROUP BY type_group_id, rule_name, max_violations`,
      [req.params.id]
    );

    await ensureSummonsAppointmentsTable(conn);
    const summonsAppointments = await conn.query(
      `SELECT sa.*,
              DATE_FORMAT(sa.scheduled_at, '%Y-%m-%dT%H:%i') AS scheduled_at_input,
              a.full_name AS summoned_by_name
       FROM summons_appointments sa
       JOIN admins a ON sa.summoned_by = a.id
       WHERE sa.registration_id = ?
       ORDER BY sa.created_at DESC`,
      [req.params.id]
    );

    res.render('registrations/detail', {
      title: `${reg.first_name} ${reg.last_name} - BU MotoSpace`,
      reg,
      violations,
      violationCounts,
      summonsAppointments,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลได้');
    res.redirect('/registrations');
  } finally {
    if (conn) conn.release();
  }
});

// POST /registrations/:id/approve
router.post('/:id/approve', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(
      'UPDATE registrations SET status = ?, approved_by = ?, approved_at = NOW() WHERE id = ?',
      ['approved', req.session.admin.id, req.params.id]
    );
    req.flash('success', 'อนุมัติเรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/registrations/' + req.params.id);
});

// POST /registrations/:id/reject
router.post('/:id/reject', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(
      'UPDATE registrations SET status = ?, notes = ? WHERE id = ?',
      ['rejected', req.body.notes || '', req.params.id]
    );
    req.flash('success', 'ปฏิเสธเรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/registrations/' + req.params.id);
});

// GET /registrations/:id/edit
router.get('/:id/edit', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [reg] = await conn.query('SELECT * FROM registrations WHERE id = ?', [req.params.id]);
    if (!reg) {
      req.flash('error', 'ไม่พบข้อมูล');
      return res.redirect('/registrations');
    }
    res.render('registrations/edit', {
      title: `แก้ไข ${reg.first_name} ${reg.last_name} - BU MotoSpace`,
      reg,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลได้');
    res.redirect('/registrations');
  } finally {
    if (conn) conn.release();
  }
});

// POST /registrations/:id/edit
router.post('/:id/edit', isHead, upload.fields([
  { name: 'motorcycle_photo', maxCount: 1 },
  { name: 'plate_photo', maxCount: 1 },
  { name: 'id_card_photo', maxCount: 1 },
]), verifyCsrf, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const { user_type, id_number, first_name, last_name, phone, license_plate, province, status } = req.body;

    // Build update query
    let sql = `UPDATE registrations SET user_type = ?, id_number = ?, first_name = ?, last_name = ?, phone = ?, license_plate = ?, province = ?, status = ?`;
    const params = [user_type, id_number, first_name, last_name, phone || null, license_plate, province, status];

    // Handle optional photo uploads
    if (req.files && req.files.motorcycle_photo) {
      sql += ', motorcycle_photo = ?';
      params.push('/uploads/motorcycles/' + req.files.motorcycle_photo[0].filename);
    }
    if (req.files && req.files.plate_photo) {
      sql += ', plate_photo = ?';
      params.push('/uploads/plates/' + req.files.plate_photo[0].filename);
    }
    if (req.files && req.files.id_card_photo) {
      sql += ', id_card_photo = ?';
      params.push('/uploads/id-cards/' + req.files.id_card_photo[0].filename);
    }

    // If status changed to approved, set approved fields
    if (status === 'approved') {
      sql += ', approved_by = ?, approved_at = NOW()';
      params.push(req.session.admin.id);
    }

    sql += ' WHERE id = ?';
    params.push(req.params.id);

    await conn.query(sql, params);
    req.flash('success', 'แก้ไขข้อมูลเรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาดในการแก้ไขข้อมูล');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/registrations/' + req.params.id);
});

// POST /registrations/:id/summons/:appointmentId/edit
router.post('/:id/summons/:appointmentId/edit', isHead, upload.single('written_document'), verifyCsrf, async (req, res) => {
  const registrationId = parseInt(req.params.id, 10);
  const appointmentId = parseInt(req.params.appointmentId, 10);
  const scheduledAtRaw = (req.body.scheduled_at || '').trim();
  const note = (req.body.note || '').trim() || null;
  const returnTo = Number.isFinite(registrationId) && registrationId > 0
    ? `/registrations/${registrationId}#summons-history`
    : '/registrations';

  if (!Number.isFinite(registrationId) || registrationId <= 0 || !Number.isFinite(appointmentId) || appointmentId <= 0) {
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'ข้อมูลรายการเรียกพบไม่ถูกต้อง');
    return res.redirect(returnTo);
  }

  if (!isValidDatetimeLocal(scheduledAtRaw)) {
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'กรุณาระบุวันและเวลานัดหมายให้ถูกต้อง');
    return res.redirect(returnTo);
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await ensureSummonsAppointmentsTable(conn);

    const [appointment] = await conn.query(
      `SELECT sa.id, r.first_name, r.last_name
       FROM summons_appointments sa
       JOIN registrations r ON sa.registration_id = r.id
       WHERE sa.id = ? AND sa.registration_id = ?`,
      [appointmentId, registrationId]
    );

    if (!appointment) {
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'ไม่พบรายการเรียกพบที่ต้องการแก้ไข');
      return res.redirect(returnTo);
    }

    let sql = `UPDATE summons_appointments
       SET scheduled_at = ?, note = ?`;
    const params = [toSqlDatetime(scheduledAtRaw), note];

    if (req.file) {
      sql += ', written_document = ?, written_document_original_name = ?';
      params.push('/uploads/summons-documents/' + req.file.filename, req.file.originalname);
    }

    sql += ' WHERE id = ? AND registration_id = ?';
    params.push(appointmentId, registrationId);

    await conn.query(sql, params);
    req.flash('success', `แก้ไขรายละเอียดการเรียกพบ ${appointment.first_name} ${appointment.last_name} เรียบร้อยแล้ว`);
  } catch (err) {
    console.error('POST /registrations/:id/summons/:appointmentId/edit error:', err);
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'ไม่สามารถแก้ไขรายละเอียดการเรียกพบได้: ' + err.message);
  } finally {
    if (conn) conn.release();
  }

  return res.redirect(returnTo);
});

// POST /registrations/:id/delete
router.post('/:id/delete', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query('DELETE FROM registrations WHERE id = ?', [req.params.id]);
    req.flash('success', 'ลบข้อมูลเรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/registrations');
});

module.exports = router;
