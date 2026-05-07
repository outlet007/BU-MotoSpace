const router = require('express').Router();
const pool = require('../config/database');
const { requireRole } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { verifyCsrf } = require('../middleware/csrf');

router.use(requireRole('head', 'superadmin'));

const DEFAULT_SUMMONS_THRESHOLD = 3;

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
  await ensureSummonsAppointmentColumn(conn, 'violation_type_id', 'INT DEFAULT NULL');
  await backfillMissingAppointmentCodes(conn);
  await ensureSummonsAppointmentIndex(conn, 'uq_summons_appointment_code', 'UNIQUE INDEX uq_summons_appointment_code (appointment_code)');
}

function positiveInt(value, fallback = DEFAULT_SUMMONS_THRESHOLD) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function ensureViolationTypeSchema(conn) {
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

  const [typeCodeColumn] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'violation_types'
       AND COLUMN_NAME = 'type_code'`
  );
  if (parseInt(typeCodeColumn.cnt, 10) === 0) {
    await conn.query('ALTER TABLE violation_types ADD COLUMN type_code VARCHAR(20) DEFAULT NULL AFTER type_name');
  }

  const [typeCodeIndex] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'violation_types'
       AND INDEX_NAME = 'uq_violation_type_code'`
  );
  if (parseInt(typeCodeIndex.cnt, 10) === 0) {
    await conn.query('ALTER TABLE violation_types ADD UNIQUE INDEX uq_violation_type_code (type_code)');
  }

  const [column] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'rules'
       AND COLUMN_NAME = 'violation_type_id'`
  );

  if (parseInt(column.cnt, 10) === 0) {
    await conn.query('ALTER TABLE rules ADD COLUMN violation_type_id INT DEFAULT NULL AFTER description');
  }

  const [index] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'rules'
       AND INDEX_NAME = 'idx_rules_violation_type'`
  );

  if (parseInt(index.cnt, 10) === 0) {
    await conn.query('ALTER TABLE rules ADD INDEX idx_rules_violation_type (violation_type_id)');
  }

  const [typeCount] = await conn.query('SELECT COUNT(*) AS cnt FROM violation_types');

  if (parseInt(typeCount.cnt, 10) === 0) {
    const maxRows = await conn.query(
      'SELECT DISTINCT max_violations FROM rules WHERE max_violations IS NOT NULL ORDER BY max_violations ASC'
    );
    const seedRows = maxRows.length > 0 ? maxRows : [{ max_violations: DEFAULT_SUMMONS_THRESHOLD }];

    for (const row of seedRows) {
      const maxViolations = positiveInt(row.max_violations);
      await conn.query(
        `INSERT INTO violation_types (type_name, max_violations, is_active)
         VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE max_violations = VALUES(max_violations)`,
        [`ประเภทความผิด ${maxViolations} ครั้ง`, maxViolations]
      );
    }
  }

  const unassignedRows = await conn.query(
    'SELECT COUNT(*) AS cnt FROM rules WHERE violation_type_id IS NULL'
  );

  if (!unassignedRows[0] || parseInt(unassignedRows[0].cnt, 10) === 0) return;

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

function isValidDatetimeLocal(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '');
}

function toSqlDatetime(datetimeLocal) {
  return datetimeLocal.replace('T', ' ') + ':00';
}

function formatMeetingDateKey(value = new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10).replace(/-/g, '');
  }

  const date = value instanceof Date ? value : new Date(value);
  const pad = input => String(input).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function formatAppointmentCode(dateKey, sequence) {
  return `MEET-${dateKey}-${String(sequence).padStart(3, '0')}`;
}

function normalizeAppointmentCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^MEET-\d{8}-\d{3,}$/.test(code) ? code : null;
}

async function getMaxAppointmentSequence(conn, dateKey) {
  const [row] = await conn.query(
    `SELECT MAX(CAST(SUBSTRING(appointment_code, 15) AS UNSIGNED)) AS max_seq
     FROM summons_appointments
     WHERE appointment_code LIKE ?`,
    [`MEET-${dateKey}-%`]
  );

  return parseInt(row && row.max_seq, 10) || 0;
}

async function appointmentCodeExists(conn, code) {
  const [row] = await conn.query(
    'SELECT COUNT(*) AS cnt FROM summons_appointments WHERE appointment_code = ?',
    [code]
  );
  return parseInt(row && row.cnt, 10) > 0;
}

async function generateAppointmentCode(conn, requestedCode = null) {
  const normalizedCode = normalizeAppointmentCode(requestedCode);
  if (normalizedCode && !(await appointmentCodeExists(conn, normalizedCode))) {
    return normalizedCode;
  }

  const dateKey = normalizedCode ? normalizedCode.slice(5, 13) : formatMeetingDateKey();
  let sequence = await getMaxAppointmentSequence(conn, dateKey);
  let code;

  do {
    sequence += 1;
    code = formatAppointmentCode(dateKey, sequence);
  } while (await appointmentCodeExists(conn, code));

  return code;
}

async function insertSummonsAppointmentWithRetry(conn, data) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const appointmentCode = await generateAppointmentCode(
      conn,
      attempt === 0 ? data.requestedAppointmentCode : null
    );

    try {
      await conn.query(
        `INSERT INTO summons_appointments
           (appointment_code, registration_id, scheduled_at, note, written_document, written_document_original_name, summoned_by, violation_type_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          appointmentCode,
          data.registrationId,
          data.scheduledAt,
          data.note,
          data.writtenDocument,
          data.writtenDocumentOriginalName,
          data.summonedBy,
          data.violationTypeId,
        ]
      );
      return appointmentCode;
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
    }
  }

  throw new Error('Unable to allocate a unique appointment code');
}

async function backfillMissingAppointmentCodes(conn) {
  const rows = await conn.query(
    `SELECT id, created_at
     FROM summons_appointments
     WHERE appointment_code IS NULL OR TRIM(appointment_code) = ''
     ORDER BY created_at ASC, id ASC`
  );

  for (const row of rows) {
    const dateKey = formatMeetingDateKey(row.created_at || new Date());
    const code = await generateAppointmentCode(conn, formatAppointmentCode(dateKey, (await getMaxAppointmentSequence(conn, dateKey)) + 1));
    await conn.query('UPDATE summons_appointments SET appointment_code = ? WHERE id = ?', [code, row.id]);
  }
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
       sa.appointment_code,
       sa.registration_id,
       sa.scheduled_at,
       DATE_FORMAT(sa.scheduled_at, '%Y-%m-%dT%H:%i') AS scheduled_at_input,
       sa.note,
       sa.written_document,
       sa.written_document_original_name,
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
  await ensureViolationTypeSchema(conn);

  const {
    search = '',
    userType = '',
    page = 1,
    limit = 20,
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

  const qualifyingRowsSql = `
    SELECT
      r.id AS registration_id,
      COALESCE(ru.violation_type_id, -ru.id) AS violation_group_id,
      COALESCE(MAX(vt.type_name), MAX(ru.rule_name)) AS type_name,
      COUNT(v.id) AS type_violations,
      COALESCE(MAX(vt.max_violations), MAX(ru.max_violations), ${DEFAULT_SUMMONS_THRESHOLD}) AS required_violations,
      MIN(v.recorded_at) AS first_recorded_at,
      MAX(v.recorded_at) AS latest_recorded_at,
      MAX(COALESCE(ru.violation_type_id, 0)) AS raw_violation_type_id
    FROM registrations r
    JOIN violations v ON v.registration_id = r.id
    JOIN rules ru ON v.rule_id = ru.id
    LEFT JOIN violation_types vt ON ru.violation_type_id = vt.id
    LEFT JOIN (
      SELECT registration_id, violation_type_id, MAX(created_at) AS latest_reset_at
      FROM summons_appointments
      WHERE violation_type_id IS NOT NULL
      GROUP BY registration_id, violation_type_id
    ) sa_type ON sa_type.registration_id = r.id
              AND sa_type.violation_type_id = ru.violation_type_id
    LEFT JOIN (
      SELECT registration_id, MAX(created_at) AS latest_reset_at
      FROM summons_appointments
      WHERE violation_type_id IS NULL
      GROUP BY registration_id
    ) sa_global ON sa_global.registration_id = r.id
    ${where}
    AND v.recorded_at > COALESCE(
      GREATEST(
        COALESCE(sa_type.latest_reset_at, '1000-01-01'),
        COALESCE(sa_global.latest_reset_at, '1000-01-01')
      ),
      '1000-01-01 00:00:00'
    )
    GROUP BY r.id, COALESCE(ru.violation_type_id, -ru.id)
    HAVING type_violations >= required_violations
  `;

  const [countRow] = await conn.query(
    `SELECT COUNT(*) as cnt FROM (${qualifyingRowsSql}) x`,
    params
  );

  const total = parseInt(countRow.cnt) || 0;
  const offset = (parseInt(page) - 1) * limit;
  const pagingSql = includeAll ? '' : 'LIMIT ? OFFSET ?';
  const pagingParams = includeAll ? [] : [limit, offset];

  const qualifiedRows = await conn.query(
    `SELECT q.*,
            r.id_number, r.user_type, r.first_name, r.last_name,
            r.phone, r.license_plate, r.province
     FROM (${qualifyingRowsSql}) q
     JOIN registrations r ON r.id = q.registration_id
     ORDER BY q.type_violations DESC, q.latest_recorded_at DESC
     ${pagingSql}`,
    [...params, ...pagingParams]
  );

  const pendingDateKey = formatMeetingDateKey();
  const pendingBaseSequence = await getMaxAppointmentSequence(conn, pendingDateKey);

  const candidates = qualifiedRows.map((row, index) => {
    const violationTypeId = Number(row.raw_violation_type_id) || 0;
    const violationGroupId = row.violation_group_id;
    return {
      appointment_code: formatAppointmentCode(pendingDateKey, pendingBaseSequence + offset + index + 1),
      id: row.registration_id,
      id_number: row.id_number,
      user_type: row.user_type,
      first_name: row.first_name,
      last_name: row.last_name,
      phone: row.phone,
      license_plate: row.license_plate,
      province: row.province,
      total_violations: Number(row.type_violations),
      first_recorded_at: row.first_recorded_at,
      latest_recorded_at: row.latest_recorded_at,
      user_type_label: row.user_type === 'student' ? 'นักศึกษา' : 'บุคลากร',
      full_name: `${row.first_name} ${row.last_name}`,
      // Only the qualifying violation type for this row
      rule_breakdown: [{
        type_name: row.type_name,
        max_violations: Number(row.required_violations),
        cnt: Number(row.type_violations),
        is_qualified: true,
      }],
      rule_summary: `${row.type_name} (${Number(row.type_violations)}/${Number(row.required_violations)})`,
      appointment_note: '',
      // For the confirm form
      violation_type_id: violationTypeId > 0 ? violationTypeId : null,
      violation_group_label: row.type_name,
    };
  });

  return {
    rows: candidates,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

const SUMMONS_FIELDS = [
  { label: 'รหัสนัดหมาย', key: 'appointment_code' },
  { label: 'รหัสประจำตัว', key: 'id_number' },
  { label: 'ประเภท', key: 'user_type_label' },
  { label: 'ชื่อ-นามสกุล', key: 'full_name' },
  { label: 'เบอร์โทร', key: 'phone' },
  { label: 'ป้ายทะเบียน', key: 'license_plate' },
  { label: 'จังหวัด', key: 'province' },
  { label: 'จำนวนครั้งรวม', key: 'total_violations' },
  { label: 'สรุปประเภทความผิด', key: 'rule_summary' },
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
    const { rows } = await fetchSummonsCandidates(conn, {
      search,
      userType: user_type,
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
router.post('/summons/:registrationId/confirm', upload.single('written_document'), verifyCsrf, async (req, res) => {
  const registrationId = parseInt(req.params.registrationId, 10);
  const scheduledAtRaw = (req.body.scheduled_at || '').trim();
  const note = (req.body.note || '').trim() || null;
  const violationTypeIdRaw = req.body.violation_type_id;
  const violationTypeId = violationTypeIdRaw ? parseInt(violationTypeIdRaw, 10) : null;
  const violationGroupLabel = (req.body.violation_group_label || '').trim() || null;
  const requestedAppointmentCode = req.body.appointment_code;
  const returnTo = req.body.return_to && req.body.return_to.startsWith('/reports/summons')
    ? req.body.return_to
    : '/reports/summons';

  if (!Number.isFinite(registrationId) || registrationId <= 0) {
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'ข้อมูลผู้เข้าข่ายเรียกพบไม่ถูกต้อง');
    return res.redirect(returnTo);
  }

  if (!isValidDatetimeLocal(scheduledAtRaw)) {
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'กรุณาระบุวันและเวลานัดหมายให้ถูกต้อง');
    return res.redirect(returnTo);
  }

  const scheduledAt = toSqlDatetime(scheduledAtRaw);
  const writtenDocument = req.file ? '/uploads/summons-documents/' + req.file.filename : null;
  const writtenDocumentOriginalName = req.file ? req.file.originalname : null;

  let conn;
  try {
    conn = await pool.getConnection();
    await ensureSummonsAppointmentsTable(conn);

    const [registration] = await conn.query(
      'SELECT id, first_name, last_name FROM registrations WHERE id = ?',
      [registrationId]
    );

    if (!registration) {
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'ไม่พบข้อมูลผู้เข้าข่ายเรียกพบ');
      return res.redirect(returnTo);
    }

    await insertSummonsAppointmentWithRetry(conn, {
      requestedAppointmentCode,
      registrationId,
      scheduledAt,
      note,
      writtenDocument,
      writtenDocumentOriginalName,
      summonedBy: req.session.admin.id,
      violationTypeId,
    });

    const typeLabel = violationGroupLabel ? ` (ประเภท: ${violationGroupLabel})` : '';
    req.flash(
      'success',
      `บันทึกการเรียกพบ ${registration.first_name} ${registration.last_name}${typeLabel} เรียบร้อยแล้ว และเริ่มนับจำนวนความผิดประเภทนี้รอบใหม่`
    );
    return res.redirect(returnTo);
  } catch (err) {
    console.error('POST /reports/summons/:registrationId/confirm error:', err);
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'ไม่สามารถบันทึกการเรียกพบได้: ' + err.message);
    return res.redirect(returnTo);
  } finally {
    if (conn) conn.release();
  }
});

// POST /reports/summons/appointments/:appointmentId/edit
router.post('/summons/appointments/:appointmentId/edit', upload.single('written_document'), verifyCsrf, async (req, res) => {
  const appointmentId = parseInt(req.params.appointmentId, 10);
  const scheduledAtRaw = (req.body.scheduled_at || '').trim();
  const note = (req.body.note || '').trim() || null;
  const returnTo = req.body.return_to && req.body.return_to.startsWith('/reports/summons')
    ? req.body.return_to
    : '/reports/summons';

  if (!Number.isFinite(appointmentId) || appointmentId <= 0) {
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
       WHERE sa.id = ?`,
      [appointmentId]
    );

    if (!appointment) {
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'ไม่พบรายการเรียกพบที่ต้องการแก้ไข');
      return res.redirect(returnTo);
    }

    let updateSql = `UPDATE summons_appointments
       SET scheduled_at = ?, note = ?`;
    const updateParams = [toSqlDatetime(scheduledAtRaw), note];

    if (req.file) {
      updateSql += ', written_document = ?, written_document_original_name = ?';
      updateParams.push('/uploads/summons-documents/' + req.file.filename, req.file.originalname);
    }

    updateSql += ' WHERE id = ?';
    updateParams.push(appointmentId);

    await conn.query(updateSql, updateParams);

    req.flash('success', `แก้ไขรายการเรียกพบ ${appointment.first_name} ${appointment.last_name} เรียบร้อยแล้ว`);
    return res.redirect(returnTo);
  } catch (err) {
    console.error('POST /reports/summons/appointments/:appointmentId/edit error:', err);
    upload.cleanupUploadedFiles(req);
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
    const report = await fetchSummonsCandidates(conn, {
      search: pendingSearch,
      userType: pendingUserType,
      page,
      limit,
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
