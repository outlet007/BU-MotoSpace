const router = require('express').Router();
const pool = require('../config/database');
const { requireRole } = require('../middleware/auth');

router.use(requireRole('head', 'superadmin'));

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

async function ensureSummonsAppointmentsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS summons_appointments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      registration_id INT NOT NULL,
      scheduled_at DATETIME NOT NULL,
      note TEXT,
      summoned_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (registration_id) REFERENCES registrations(id) ON DELETE CASCADE,
      FOREIGN KEY (summoned_by) REFERENCES admins(id) ON DELETE CASCADE,
      INDEX idx_registration_created (registration_id, created_at),
      INDEX idx_scheduled_at (scheduled_at)
    ) ENGINE=InnoDB
  `);
}

function isValidDatetimeLocal(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '');
}

function toSqlDatetime(datetimeLocal) {
  return datetimeLocal.replace('T', ' ') + ':00';
}

async function fetchSummonsAppointments(conn, options = {}) {
  await ensureSummonsAppointmentsTable(conn);

  const {
    search = '',
    userType = '',
    limit = 50,
  } = options;

  let where = 'WHERE 1=1';
  const params = [];

  if (search && search.trim()) {
    const searchTrimmed = search.trim().replace(/\s+/g, ' ');
    const s = `%${searchTrimmed}%`;
    const sNoSpace = `%${searchTrimmed.replace(/\s+/g, '')}%`;
    where += ` AND (
      r.id_number LIKE ? OR
      r.first_name LIKE ? OR
      r.last_name LIKE ? OR
      CONCAT(r.first_name, ' ', r.last_name) LIKE ? OR
      r.license_plate LIKE ? OR
      REPLACE(r.license_plate, ' ', '') LIKE ? OR
      r.phone LIKE ?
    )`;
    params.push(s, s, s, s, s, sNoSpace, s);
  }

  if (userType === 'student' || userType === 'staff') {
    where += ' AND r.user_type = ?';
    params.push(userType);
  }

  const [countRow] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM summons_appointments sa
     JOIN registrations r ON sa.registration_id = r.id
     ${where}`,
    params
  );

  const rows = await conn.query(
    `SELECT
       sa.id,
       sa.registration_id,
       sa.scheduled_at,
       DATE_FORMAT(sa.scheduled_at, '%Y-%m-%dT%H:%i') AS scheduled_at_input,
       sa.note,
       sa.created_at,
       r.id_number,
       r.user_type,
       r.first_name,
       r.last_name,
       r.phone,
       r.license_plate,
       r.province,
       a.full_name AS summoned_by_name
     FROM summons_appointments sa
     JOIN registrations r ON sa.registration_id = r.id
     JOIN admins a ON sa.summoned_by = a.id
     ${where}
     ORDER BY sa.created_at DESC, sa.id DESC
     LIMIT ?`,
    [...params, limit]
  );

  rows.forEach(row => {
    row.full_name = `${row.first_name} ${row.last_name}`;
    row.user_type_label = row.user_type === 'student' ? 'นักศึกษา' : 'บุคลากร';
  });

  return {
    rows,
    total: parseInt(countRow.cnt, 10) || 0,
  };
}

// Helper: CSV builder with UTF-8 BOM
function buildCSV(fields, data) {
  const BOM = '\uFEFF';
  const header = fields.map(f => `"${f.label}"`).join(',');
  const rows = data.map(item =>
    fields.map(f => {
      let v = item[f.key];
      if (v == null) v = '';
      if (v instanceof Date) v = v.toLocaleString('th-TH');
      return `"${String(v).replace(/"/g, '""')}"`;
    }).join(',')
  );
  return BOM + header + '\n' + rows.join('\n');
}

// Report type definitions
const REPORT_TYPES = {
  reg_all:       { label: 'ทะเบียนรถทั้งหมด', icon: 'clipboard-list' },
  reg_student:   { label: 'ทะเบียนรถนักศึกษา', icon: 'graduation-cap' },
  reg_staff:     { label: 'ทะเบียนรถบุคลากร', icon: 'briefcase' },
  violations:    { label: 'บันทึกการกระทำผิดกฎ', icon: 'shield-alert' },
  summary:       { label: 'สรุปภาพรวมระบบ', icon: 'pie-chart' }
};

// Helper: build query + fields for a report type
async function fetchReport(conn, type, startDate, endDate) {
  let dateFilter = '';
  let params = [];

  if (startDate && endDate) {
    // Use range comparison instead of DATE() to leverage indexes
    const col = type === 'violations' ? 'v.recorded_at' : 'registered_at';
    dateFilter = ` AND ${col} >= ? AND ${col} < DATE_ADD(?, INTERVAL 1 DAY) `;
    params = [startDate, endDate];
  }

  if (type === 'reg_all' || type === 'reg_student' || type === 'reg_staff') {
    let typeFilter = '';
    if (type === 'reg_student') { typeFilter = " AND user_type = 'student' "; }
    if (type === 'reg_staff')   { typeFilter = " AND user_type = 'staff' "; }

    const rows = await conn.query(
      `SELECT id_number, user_type, first_name, last_name, phone, license_plate, province, status, registered_at
       FROM registrations WHERE 1=1 ${dateFilter} ${typeFilter} ORDER BY registered_at DESC`, params
    );

    const fields = [
      { label: 'รหัสประจำตัว', key: 'id_number' },
      { label: 'ประเภท', key: 'user_type_label' },
      { label: 'ชื่อ', key: 'first_name' },
      { label: 'นามสกุล', key: 'last_name' },
      { label: 'เบอร์โทร', key: 'phone' },
      { label: 'ป้ายทะเบียน', key: 'license_plate' },
      { label: 'จังหวัด', key: 'province' },
      { label: 'สถานะ', key: 'status_label' },
      { label: 'วันที่ลงทะเบียน', key: 'registered_at' }
    ];

    rows.forEach(r => {
      r.user_type_label = r.user_type === 'student' ? 'นักศึกษา' : 'บุคลากร';
      r.status_label = r.status === 'approved' ? 'อนุมัติ' : r.status === 'pending' ? 'รอดำเนินการ' : 'ปฏิเสธ';
    });
    return { fields, rows };

  } else if (type === 'violations') {
    const rows = await conn.query(
      `SELECT r.id_number, r.user_type, r.first_name, r.last_name, r.license_plate, ru.rule_name, v.description, v.recorded_at
       FROM violations v
       JOIN registrations r ON v.registration_id = r.id
       JOIN rules ru ON v.rule_id = ru.id
       WHERE 1=1 ${dateFilter} ORDER BY v.recorded_at DESC`, params
    );

    const fields = [
      { label: 'รหัสประจำตัว', key: 'id_number' },
      { label: 'ประเภท', key: 'user_type_label' },
      { label: 'ชื่อ-นามสกุล', key: 'full_name' },
      { label: 'ป้ายทะเบียน', key: 'license_plate' },
      { label: 'กฎที่ฝ่าฝืน', key: 'rule_name' },
      { label: 'รายละเอียด', key: 'description' },
      { label: 'วันที่กระทำผิด', key: 'recorded_at' }
    ];

    rows.forEach(r => {
      r.user_type_label = r.user_type === 'student' ? 'นักศึกษา' : 'บุคลากร';
      r.full_name = r.first_name + ' ' + r.last_name;
    });

    return { fields, rows };

  } else if (type === 'summary') {
    const regCounts = await conn.query(
      `SELECT user_type, status, COUNT(*) as cnt FROM registrations WHERE 1=1 ${dateFilter} GROUP BY user_type, status`, params
    );
    const vioCounts = await conn.query(
      `SELECT ru.rule_name, COUNT(v.id) as cnt FROM violations v JOIN rules ru ON v.rule_id = ru.id WHERE 1=1 ${dateFilter.replace('registered_at', 'v.recorded_at')} GROUP BY ru.id, ru.rule_name ORDER BY cnt DESC`, params
    );
    const topProv = await conn.query(
      `SELECT province, COUNT(*) as cnt FROM registrations WHERE status='approved' ${dateFilter} GROUP BY province ORDER BY cnt DESC LIMIT 5`, params
    );
    return { isSummary: true, regCounts, vioCounts, topProv };
  }

  return { fields: [], rows: [] };
}

async function fetchSummonsCandidates(conn, options = {}) {
  await ensureSummonsAppointmentsTable(conn);

  const {
    search = '',
    userType = '',
    page = 1,
    limit = 20,
    threshold = 3,
    includeAll = false,
  } = options;

  let where = 'WHERE 1=1';
  const params = [];

  if (search && search.trim()) {
    const searchTrimmed = search.trim().replace(/\s+/g, ' ');
    const s = `%${searchTrimmed}%`;
    const sNoSpace = `%${searchTrimmed.replace(/\s+/g, '')}%`;
    where += ` AND (
      r.id_number LIKE ? OR
      r.first_name LIKE ? OR
      r.last_name LIKE ? OR
      CONCAT(r.first_name, ' ', r.last_name) LIKE ? OR
      r.license_plate LIKE ? OR
      REPLACE(r.license_plate, ' ', '') LIKE ? OR
      r.phone LIKE ?
    )`;
    params.push(s, s, s, s, s, sNoSpace, s);
  }

  if (userType === 'student' || userType === 'staff') {
    where += ' AND r.user_type = ?';
    params.push(userType);
  }

  const [countRow] = await conn.query(
    `SELECT COUNT(*) as cnt
     FROM (
       SELECT r.id
       FROM registrations r
       LEFT JOIN (
         SELECT registration_id, MAX(created_at) AS latest_reset_at
         FROM summons_appointments
         GROUP BY registration_id
       ) sa ON sa.registration_id = r.id
       JOIN violations v
         ON v.registration_id = r.id
        AND v.recorded_at > COALESCE(sa.latest_reset_at, '1000-01-01 00:00:00')
       ${where}
       GROUP BY r.id
       HAVING COUNT(v.id) >= ?
     ) x`,
    [...params, threshold]
  );

  const total = parseInt(countRow.cnt) || 0;
  const offset = (parseInt(page) - 1) * limit;
  const pagingSql = includeAll ? '' : 'LIMIT ? OFFSET ?';
  const pagingParams = includeAll ? [] : [limit, offset];

  const candidates = await conn.query(
    `SELECT
       r.id,
       r.id_number,
       r.user_type,
       r.first_name,
       r.last_name,
       r.phone,
       r.license_plate,
       r.province,
       COUNT(v.id) AS total_violations,
       MIN(v.recorded_at) AS first_recorded_at,
       MAX(v.recorded_at) AS latest_recorded_at,
       sa.latest_reset_at
     FROM registrations r
     LEFT JOIN (
       SELECT registration_id, MAX(created_at) AS latest_reset_at
       FROM summons_appointments
       GROUP BY registration_id
     ) sa ON sa.registration_id = r.id
     JOIN violations v
       ON v.registration_id = r.id
      AND v.recorded_at > COALESCE(sa.latest_reset_at, '1000-01-01 00:00:00')
     ${where}
     GROUP BY r.id, r.id_number, r.user_type, r.first_name, r.last_name, r.phone, r.license_plate, r.province, sa.latest_reset_at
     HAVING COUNT(v.id) >= ?
     ORDER BY total_violations DESC, latest_recorded_at DESC
     ${pagingSql}`,
    [...params, threshold, ...pagingParams]
  );

  if (candidates.length > 0) {
    const ids = candidates.map(c => c.id);
    const placeholders = ids.map(() => '?').join(',');
    const breakdownRows = await conn.query(
      `SELECT v.registration_id, ru.rule_name, COUNT(v.id) AS cnt
       FROM violations v
       JOIN rules ru ON v.rule_id = ru.id
       LEFT JOIN (
         SELECT registration_id, MAX(created_at) AS latest_reset_at
         FROM summons_appointments
         GROUP BY registration_id
       ) sa ON sa.registration_id = v.registration_id
       WHERE v.registration_id IN (${placeholders})
         AND v.recorded_at > COALESCE(sa.latest_reset_at, '1000-01-01 00:00:00')
       GROUP BY v.registration_id, ru.id, ru.rule_name
       ORDER BY v.registration_id, cnt DESC, ru.rule_name`,
      ids
    );

    const byRegistration = new Map();
    breakdownRows.forEach(row => {
      const regId = Number(row.registration_id);
      if (!byRegistration.has(regId)) byRegistration.set(regId, []);
      byRegistration.get(regId).push({
        rule_name: row.rule_name,
        cnt: Number(row.cnt),
      });
    });

    candidates.forEach(candidate => {
      candidate.total_violations = Number(candidate.total_violations);
      candidate.user_type_label = candidate.user_type === 'student' ? 'นักศึกษา' : 'บุคลากร';
      candidate.full_name = `${candidate.first_name} ${candidate.last_name}`;
      candidate.rule_breakdown = byRegistration.get(Number(candidate.id)) || [];
      candidate.rule_summary = candidate.rule_breakdown
        .map(rule => `${rule.rule_name} (${rule.cnt})`)
        .join(', ');
      candidate.appointment_note = '';
    });
  }

  return {
    rows: candidates,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

const SUMMONS_FIELDS = [
  { label: 'รหัสประจำตัว', key: 'id_number' },
  { label: 'ประเภท', key: 'user_type_label' },
  { label: 'ชื่อ-นามสกุล', key: 'full_name' },
  { label: 'เบอร์โทร', key: 'phone' },
  { label: 'ป้ายทะเบียน', key: 'license_plate' },
  { label: 'จังหวัด', key: 'province' },
  { label: 'จำนวนครั้งรวม', key: 'total_violations' },
  { label: 'สรุปกฎที่ฝ่าฝืน', key: 'rule_summary' },
  { label: 'วันที่ทำผิดครั้งแรก', key: 'first_recorded_at' },
  { label: 'วันที่ทำผิดล่าสุด', key: 'latest_recorded_at' },
  { label: 'หมายเหตุการนัดหมาย', key: 'appointment_note' },
];

// GET /reports/summons/export
router.get('/summons/export', async (req, res) => {
  const search = req.query.pending_search ?? req.query.search ?? '';
  const user_type = req.query.pending_user_type ?? req.query.user_type ?? '';

  let conn;
  try {
    conn = await pool.getConnection();
    const threshold = await getSummonsThreshold(conn);
    const { rows } = await fetchSummonsCandidates(conn, {
      search,
      userType: user_type,
      threshold,
      includeAll: true,
    });

    const csv = buildCSV(SUMMONS_FIELDS, rows);
    const safeFilename = 'summons_report.csv';
    const thaiFilename = 'รายงานผู้เข้าข่ายเรียกพบ.csv';

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(thaiFilename)}`
    );

    return res.send(Buffer.from(csv, 'utf-8'));
  } catch (err) {
    console.error('Summons Export Error:', err);
    req.flash('error', 'เกิดข้อผิดพลาดในการส่งออกรายงานผู้เข้าข่ายเรียกพบ');
    return res.redirect('/reports/summons');
  } finally {
    if (conn) conn.release();
  }
});

// POST /reports/summons/:registrationId/confirm
router.post('/summons/:registrationId/confirm', async (req, res) => {
  const registrationId = parseInt(req.params.registrationId, 10);
  const scheduledAtRaw = (req.body.scheduled_at || '').trim();
  const note = (req.body.note || '').trim() || null;
  const returnTo = req.body.return_to && req.body.return_to.startsWith('/reports/summons')
    ? req.body.return_to
    : '/reports/summons';

  if (!Number.isFinite(registrationId) || registrationId <= 0) {
    req.flash('error', 'ข้อมูลผู้เข้าข่ายเรียกพบไม่ถูกต้อง');
    return res.redirect(returnTo);
  }

  if (!isValidDatetimeLocal(scheduledAtRaw)) {
    req.flash('error', 'กรุณาระบุวันและเวลานัดหมายให้ถูกต้อง');
    return res.redirect(returnTo);
  }

  const scheduledAt = toSqlDatetime(scheduledAtRaw);

  let conn;
  try {
    conn = await pool.getConnection();
    await ensureSummonsAppointmentsTable(conn);

    const [registration] = await conn.query(
      'SELECT id, first_name, last_name FROM registrations WHERE id = ?',
      [registrationId]
    );

    if (!registration) {
      req.flash('error', 'ไม่พบข้อมูลผู้เข้าข่ายเรียกพบ');
      return res.redirect(returnTo);
    }

    await conn.query(
      `INSERT INTO summons_appointments (registration_id, scheduled_at, note, summoned_by)
       VALUES (?, ?, ?, ?)`,
      [registrationId, scheduledAt, note, req.session.admin.id]
    );

    req.flash(
      'success',
      `บันทึกการเรียกพบ ${registration.first_name} ${registration.last_name} เรียบร้อยแล้ว และเริ่มนับจำนวนความผิดรอบใหม่`
    );
    return res.redirect(returnTo);
  } catch (err) {
    console.error('POST /reports/summons/:registrationId/confirm error:', err);
    req.flash('error', 'ไม่สามารถบันทึกการเรียกพบได้: ' + err.message);
    return res.redirect(returnTo);
  } finally {
    if (conn) conn.release();
  }
});

// POST /reports/summons/appointments/:appointmentId/edit
router.post('/summons/appointments/:appointmentId/edit', async (req, res) => {
  const appointmentId = parseInt(req.params.appointmentId, 10);
  const scheduledAtRaw = (req.body.scheduled_at || '').trim();
  const note = (req.body.note || '').trim() || null;
  const returnTo = req.body.return_to && req.body.return_to.startsWith('/reports/summons')
    ? req.body.return_to
    : '/reports/summons';

  if (!Number.isFinite(appointmentId) || appointmentId <= 0) {
    req.flash('error', 'ข้อมูลรายการเรียกพบไม่ถูกต้อง');
    return res.redirect(returnTo);
  }

  if (!isValidDatetimeLocal(scheduledAtRaw)) {
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
       WHERE sa.id = ?`,
      [appointmentId]
    );

    if (!appointment) {
      req.flash('error', 'ไม่พบรายการเรียกพบที่ต้องการแก้ไข');
      return res.redirect(returnTo);
    }

    await conn.query(
      `UPDATE summons_appointments
       SET scheduled_at = ?, note = ?
       WHERE id = ?`,
      [toSqlDatetime(scheduledAtRaw), note, appointmentId]
    );

    req.flash('success', `แก้ไขรายการเรียกพบ ${appointment.first_name} ${appointment.last_name} เรียบร้อยแล้ว`);
    return res.redirect(returnTo);
  } catch (err) {
    console.error('POST /reports/summons/appointments/:appointmentId/edit error:', err);
    req.flash('error', 'ไม่สามารถแก้ไขรายการเรียกพบได้: ' + err.message);
    return res.redirect(returnTo);
  } finally {
    if (conn) conn.release();
  }
});

// GET /reports/summons
router.get('/summons', async (req, res) => {
  const pendingSearch = req.query.pending_search ?? req.query.search ?? '';
  const pendingUserType = req.query.pending_user_type ?? req.query.user_type ?? '';
  const completedSearch = req.query.completed_search ?? '';
  const completedUserType = req.query.completed_user_type ?? '';
  const activeTab = req.query.active_tab === 'completed' ? 'completed' : 'pending';
  const page = req.query.pending_page ?? req.query.page ?? 1;
  const limit = 20;

  let conn;
  try {
    conn = await pool.getConnection();
    const threshold = await getSummonsThreshold(conn);
    const report = await fetchSummonsCandidates(conn, {
      search: pendingSearch,
      userType: pendingUserType,
      page,
      limit,
      threshold,
    });
    const summonedReport = await fetchSummonsAppointments(conn, {
      search: completedSearch,
      userType: completedUserType,
    });

    res.render('reports/summons', {
      title: 'รายงานผู้เข้าข่ายเรียกพบ - BU MotoSpace',
      candidates: report.rows,
      summonedAppointments: summonedReport.rows,
      summonedTotal: summonedReport.total,
      total: report.total,
      totalPages: report.totalPages,
      currentPage: parseInt(page),
      search: pendingSearch,
      user_type: pendingUserType,
      pendingSearch,
      pendingUserType,
      completedSearch,
      completedUserType,
      activeTab,
      threshold,
    });
  } catch (err) {
    console.error('GET /reports/summons error:', err);
    req.flash('error', 'ไม่สามารถโหลดรายงานผู้เข้าข่ายเรียกพบได้');
    res.render('reports/summons', {
      title: 'รายงานผู้เข้าข่ายเรียกพบ - BU MotoSpace',
      candidates: [],
      summonedAppointments: [],
      summonedTotal: 0,
      total: 0,
      totalPages: 0,
      currentPage: 1,
      search: pendingSearch,
      user_type: pendingUserType,
      pendingSearch,
      pendingUserType,
      completedSearch,
      completedUserType,
      activeTab,
      threshold: DEFAULT_SUMMONS_THRESHOLD,
    });
  } finally {
    if (conn) conn.release();
  }
});

// ★★★ IMPORTANT: /export route MUST be defined BEFORE the / route ★★★
// GET /reports/export
router.get('/export', async (req, res) => {
  const { report_type, start_date, end_date } = req.query;
  
  if (!report_type || !REPORT_TYPES[report_type] || report_type === 'summary') {
    req.flash('error', 'ประเภทรายงานไม่ถูกต้อง');
    return res.redirect('/reports');
  }

  let conn;
  try {
    conn = await pool.getConnection();
    const { fields, rows } = await fetchReport(conn, report_type, start_date, end_date);
    const csv = buildCSV(fields, rows);
    
    // Use ASCII-safe filename for Content-Disposition + UTF-8 filename* for modern browsers
    const safeFilename = 'report_' + report_type + '.csv';
    const thaiFilename = REPORT_TYPES[report_type].label + '.csv';
    
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 
      `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(thaiFilename)}`
    );
    
    return res.send(Buffer.from(csv, 'utf-8'));
  } catch (err) {
    console.error('Export Error:', err);
    req.flash('error', 'เกิดข้อผิดพลาดในการส่งออก CSV');
    return res.redirect('/reports');
  } finally {
    if (conn) conn.release();
  }
});

// GET /reports
router.get('/', async (req, res) => {
  const { report_type, start_date, end_date } = req.query;
  const searched = !!report_type;
  let reportData = null;

  if (searched) {
    let conn;
    try {
      conn = await pool.getConnection();
      reportData = await fetchReport(conn, report_type, start_date, end_date);
    } catch (err) {
      console.error(err);
      req.flash('error', 'ไม่สามารถโหลดข้อมูลรายงานได้');
    } finally {
      if (conn) conn.release();
    }
  }

  res.render('reports/index', {
    title: 'รายงาน - BU MotoSpace',
    reportTypes: REPORT_TYPES,
    selectedType: report_type || '',
    start_date: start_date || '',
    end_date: end_date || '',
    searched,
    reportData,
    selectedTypeLabel: report_type ? (REPORT_TYPES[report_type]?.label || '') : '',
    selectedTypeIcon: report_type ? (REPORT_TYPES[report_type]?.icon || '') : ''
  });
});

module.exports = router;
