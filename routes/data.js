const router = require('express').Router();
const pool = require('../config/database');
const { isAuthenticated, isSuperAdmin } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { verifyCsrf } = require('../middleware/csrf');
const { Parser } = require('json2csv');
const fs = require('fs');
const xlsx = require('xlsx');
const csvParser = require('csv-parser');
const { ensureVehicleSchema, assertPlateAvailable, normalizePlate, findCanonicalOwnerRegistrationId } = require('../utils/vehicles');

router.use(isAuthenticated, isSuperAdmin);

const DATASET_CONFIG = {
  registrations: {
    label: 'ข้อมูลทะเบียนรถ',
    table: 'registrations',
    dateColumn: 'registered_at',
    searchColumns: ['id_number', 'first_name', 'last_name', 'license_plate', 'phone', 'province'],
    selectSql: `
      SELECT id, user_type, id_number, first_name, last_name, phone, license_plate, province,
             status, registered_at, deleted_at, delete_reason
      FROM registrations`,
    exportFields: [
      { label: 'ID', value: 'id' },
      { label: 'ประเภท', value: 'user_type' },
      { label: 'รหัส', value: 'id_number' },
      { label: 'ชื่อ', value: 'first_name' },
      { label: 'นามสกุล', value: 'last_name' },
      { label: 'โทรศัพท์', value: 'phone' },
      { label: 'ป้ายทะเบียน', value: 'license_plate' },
      { label: 'จังหวัด', value: 'province' },
      { label: 'สถานะ', value: 'status' },
      { label: 'วันที่ลงทะเบียน', value: 'registered_at' },
      { label: 'วันที่ลบ', value: 'deleted_at' },
      { label: 'เหตุผลการลบ', value: 'delete_reason' },
    ],
  },
  violations: {
    label: 'ข้อมูลการกระทำผิด',
    table: 'violations',
    dateColumn: 'recorded_at',
    searchColumns: ['r.id_number', 'r.first_name', 'r.last_name', 'r.license_plate', 'ru.rule_name', 'v.description'],
    selectSql: `
      SELECT v.id, v.registration_id, r.id_number, r.first_name, r.last_name, r.license_plate,
             ru.rule_name, v.description, v.recorded_at, v.deleted_at, v.delete_reason
      FROM violations v
      JOIN registrations r ON v.registration_id = r.id
      JOIN rules ru ON v.rule_id = ru.id`,
    exportFields: [
      { label: 'ID', value: 'id' },
      { label: 'รหัส', value: 'id_number' },
      { label: 'ชื่อ', value: 'first_name' },
      { label: 'นามสกุล', value: 'last_name' },
      { label: 'ป้ายทะเบียน', value: 'license_plate' },
      { label: 'กฎที่ฝ่าฝืน', value: 'rule_name' },
      { label: 'รายละเอียด', value: 'description' },
      { label: 'วันที่บันทึก', value: 'recorded_at' },
      { label: 'วันที่ลบ', value: 'deleted_at' },
      { label: 'เหตุผลการลบ', value: 'delete_reason' },
    ],
  },
};

const configuredImportLimit = parseInt(process.env.MAX_IMPORT_ROWS || '5000', 10);
const MAX_IMPORT_ROWS = Number.isFinite(configuredImportLimit) && configuredImportLimit > 0
  ? configuredImportLimit
  : 5000;

function getDatasetConfig(dataset) {
  return DATASET_CONFIG[dataset] || DATASET_CONFIG.registrations;
}

function parseIds(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(raw
    .map(id => parseInt(id, 10))
    .filter(id => Number.isFinite(id) && id > 0))];
}

function placeholders(items) {
  return items.map(() => '?').join(',');
}

function buildManageWhere(config, query, alias) {
  const filters = [];
  const params = [];
  const status = query.status || 'active';
  const search = (query.search || '').trim().replace(/\s+/g, ' ');
  const deletedColumn = alias ? `${alias}.deleted_at` : 'deleted_at';

  if (status === 'deleted') {
    filters.push(`${deletedColumn} IS NOT NULL`);
  } else if (status !== 'all') {
    filters.push(`${deletedColumn} IS NULL`);
  }

  if (search) {
    const s = `%${search}%`;
    const searchFilter = config.searchColumns.map(column => `${column} LIKE ?`).join(' OR ');
    filters.push(`(${searchFilter})`);
    config.searchColumns.forEach(() => params.push(s));
  }

  return {
    where: filters.length ? `WHERE ${filters.join(' AND ')}` : '',
    params,
    status,
    search,
  };
}

async function fetchRowsForDataset(conn, dataset, ids) {
  const config = getDatasetConfig(dataset);
  const idColumn = dataset === 'violations' ? 'v.id' : 'id';
  return conn.query(
    `${config.selectSql} WHERE ${idColumn} IN (${placeholders(ids)}) ORDER BY ${idColumn} DESC`,
    ids
  );
}

async function logDeletionSnapshots(conn, dataset, rows, deleteType, reason, adminId) {
  for (const row of rows) {
    await conn.query(
      `INSERT INTO data_deletion_logs (dataset, record_id, delete_type, snapshot_json, reason, deleted_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [dataset, row.id, deleteType, JSON.stringify(row), reason || null, adminId || null]
    );
  }
}

function normalizeDateInput(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function buildRegistrationDateFilters(query) {
  const registeredFrom = normalizeDateInput(query.registered_from);
  const registeredTo = normalizeDateInput(query.registered_to);
  const status = ['active', 'deleted', 'all'].includes(query.status) ? query.status : 'active';
  const filters = [];
  const params = [];

  if (status === 'deleted') {
    filters.push('r.deleted_at IS NOT NULL');
  } else if (status === 'active') {
    filters.push('r.deleted_at IS NULL');
  }

  if (registeredFrom) {
    filters.push('r.registered_at >= ?');
    params.push(`${registeredFrom} 00:00:00`);
  }

  if (registeredTo) {
    filters.push('r.registered_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(`${registeredTo} 00:00:00`);
  }

  return {
    where: filters.length ? `WHERE ${filters.join(' AND ')}` : '',
    params,
    registeredFrom,
    registeredTo,
    status,
    hasDateRange: Boolean(registeredFrom && registeredTo),
  };
}

function getManageView(value, status) {
  if (status === 'deleted') return 'deleted';
  return value === 'deleted' ? 'deleted' : 'registrations';
}

function buildSoftDeletedDateClause(filters) {
  if (!filters.hasDateRange) {
    return { clause: '', params: [] };
  }

  return {
    clause: 'AND r.registered_at >= ? AND r.registered_at < DATE_ADD(?, INTERVAL 1 DAY)',
    params: [`${filters.registeredFrom} 00:00:00`, `${filters.registeredTo} 00:00:00`],
  };
}

async function fetchManagedRegistrations(conn, filters, limit, offset) {
  return conn.query(
    `SELECT r.id, r.user_type, r.id_number, r.first_name, r.last_name, r.phone, r.license_plate,
            r.province, r.status, r.registered_at, r.deleted_at, r.delete_reason,
            da.full_name AS deleted_by_name,
            COUNT(DISTINCT v.id) AS violation_count,
            COUNT(DISTINCT vr.id) AS report_count,
            COUNT(DISTINCT sa.id) AS summons_count
     FROM registrations r
     LEFT JOIN violations v ON v.registration_id = r.id
     LEFT JOIN violation_reports vr ON vr.registration_id = r.id
     LEFT JOIN summons_appointments sa ON sa.registration_id = r.id
     LEFT JOIN admins da ON r.deleted_by = da.id
     ${filters.where}
     GROUP BY r.id
     ORDER BY r.registered_at DESC
     LIMIT ? OFFSET ?`,
    [...filters.params, limit, offset]
  );
}

async function countSoftDeletedRows(conn, filters) {
  const dateFilter = buildSoftDeletedDateClause(filters);
  const [result] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM registrations r
     WHERE r.deleted_at IS NOT NULL ${dateFilter.clause}`,
    dateFilter.params
  );

  return Number(result && result.cnt) || 0;
}

function buildSoftDeletedSelectSql(filters) {
  const dateFilter = buildSoftDeletedDateClause(filters);

  return {
    sql: `SELECT *
     FROM (
       SELECT 'registration' AS record_type, r.id, r.id AS registration_id,
              r.id_number, r.first_name, r.last_name, r.license_plate, r.province,
              r.status, '' AS rule_name, '' AS description,
              r.registered_at AS source_date, r.deleted_at, r.delete_reason,
              da.full_name AS deleted_by_name
       FROM registrations r
       LEFT JOIN admins da ON r.deleted_by = da.id
       WHERE r.deleted_at IS NOT NULL ${dateFilter.clause}
     ) deleted_rows`,
    params: dateFilter.params,
  };
}

async function fetchSoftDeletedRows(conn, filters, limit, offset) {
  const select = buildSoftDeletedSelectSql(filters);

  return conn.query(
    `${select.sql}
     ORDER BY deleted_at DESC
     LIMIT ? OFFSET ?`,
    [...select.params, limit, offset]
  );
}

async function fetchSoftDeletedSnapshots(conn, filters) {
  const select = buildSoftDeletedSelectSql(filters);
  return conn.query(
    `${select.sql}
     ORDER BY deleted_at DESC`,
    select.params
  );
}

async function logHardDeleteSoftDeletedSnapshots(conn, rows, reason, adminId) {
  for (const row of rows) {
    await conn.query(
      `INSERT INTO data_deletion_logs (dataset, record_id, delete_type, snapshot_json, reason, deleted_by)
       VALUES (?, ?, 'hard', ?, ?, ?)`,
      [row.record_type, row.id, JSON.stringify(row), reason || null, adminId || null]
    );
  }
}

async function hardDeleteSoftDeletedRows(conn, filters) {
  const dateFilter = buildSoftDeletedDateClause(filters);
  const registrationRows = await conn.query(
    `SELECT r.id
     FROM registrations r
     WHERE r.deleted_at IS NOT NULL ${dateFilter.clause}`,
    dateFilter.params
  );
  const registrationIds = registrationRows.map(row => row.id);

  if (!registrationIds.length) {
    return {
      registrations: 0,
      violations: 0,
      reports: 0,
      summons: 0,
    };
  }

  const violationRows = await conn.query(
    `SELECT v.id
     FROM violations v
     WHERE v.registration_id IN (${placeholders(registrationIds)})`,
    registrationIds
  );
  const violationIds = violationRows.map(row => row.id);

  const reportDelete = await conn.query(
    `DELETE FROM violation_reports
     WHERE registration_id IN (${placeholders(registrationIds)})`,
    registrationIds
  );

  const summonsDelete = await conn.query(
    `DELETE FROM summons_appointments
     WHERE registration_id IN (${placeholders(registrationIds)})`,
    registrationIds
  );

  if (violationIds.length) {
    await conn.query(
      `UPDATE violation_reports SET violation_id = NULL WHERE violation_id IN (${placeholders(violationIds)})`,
      violationIds
    );
  }

  const violationDelete = await conn.query(
    `DELETE FROM violations
     WHERE registration_id IN (${placeholders(registrationIds)})`,
    registrationIds
  );

  const registrationDelete = await conn.query(
    `DELETE FROM registrations
     WHERE id IN (${placeholders(registrationIds)})`,
    registrationIds
  );

  return {
    registrations: Number(registrationDelete.affectedRows) || 0,
    violations: Number(violationDelete.affectedRows) || 0,
    reports: Number(reportDelete.affectedRows) || 0,
    summons: Number(summonsDelete.affectedRows) || 0,
  };
}

async function fetchRegistrationBackups(conn, filters) {
  return conn.query(
    `SELECT r.id, r.user_type, r.id_number, r.first_name, r.last_name, r.phone, r.license_plate,
            r.province, r.status, r.registered_at, r.deleted_at, r.delete_reason
     FROM registrations r
     ${filters.where}
     ORDER BY r.registered_at DESC`,
    filters.params
  );
}

async function fetchViolationBackups(conn, registrationIds) {
  if (!registrationIds.length) return [];
  return conn.query(
    `SELECT v.id, v.registration_id, r.id_number, r.first_name, r.last_name, r.license_plate,
            ru.rule_name, v.description, v.recorded_at, v.deleted_at, v.delete_reason
     FROM violations v
     JOIN registrations r ON v.registration_id = r.id
     JOIN rules ru ON v.rule_id = ru.id
     WHERE v.registration_id IN (${placeholders(registrationIds)})
     ORDER BY v.recorded_at DESC`,
    registrationIds
  );
}

async function fetchReportBackups(conn, registrationIds) {
  if (!registrationIds.length) return [];
  return conn.query(
    `SELECT vr.id, vr.registration_id, r.id_number, r.first_name, r.last_name, r.license_plate,
            ru.rule_name, vr.description, vr.status, vr.reported_at, vr.reviewed_at,
            vr.deleted_at, vr.delete_reason
     FROM violation_reports vr
     JOIN registrations r ON vr.registration_id = r.id
     JOIN rules ru ON vr.rule_id = ru.id
     WHERE vr.registration_id IN (${placeholders(registrationIds)})
     ORDER BY vr.reported_at DESC`,
    registrationIds
  );
}

async function fetchSummonsBackups(conn, registrationIds) {
  if (!registrationIds.length) return [];
  return conn.query(
    `SELECT sa.id, sa.registration_id, r.id_number, r.first_name, r.last_name, r.license_plate,
            sa.appointment_code, sa.scheduled_at, sa.note, sa.created_at,
            sa.deleted_at, sa.delete_reason
     FROM summons_appointments sa
     JOIN registrations r ON sa.registration_id = r.id
     WHERE sa.registration_id IN (${placeholders(registrationIds)})
     ORDER BY sa.created_at DESC`,
    registrationIds
  );
}

function buildCombinedBackupRows(registrations, violations, reports, summons) {
  return [
    ...registrations.map(row => ({
      record_type: 'registration',
      id: row.id,
      registration_id: row.id,
      id_number: row.id_number,
      first_name: row.first_name,
      last_name: row.last_name,
      phone: row.phone,
      license_plate: row.license_plate,
      province: row.province,
      status: row.status,
      rule_name: '',
      description: '',
      registered_at: row.registered_at,
      recorded_at: '',
      deleted_at: row.deleted_at,
      delete_reason: row.delete_reason,
    })),
    ...violations.map(row => ({
      record_type: 'violation',
      id: row.id,
      registration_id: row.registration_id,
      id_number: row.id_number,
      first_name: row.first_name,
      last_name: row.last_name,
      phone: '',
      license_plate: row.license_plate,
      province: '',
      status: '',
      rule_name: row.rule_name,
      description: row.description,
      registered_at: '',
      recorded_at: row.recorded_at,
      deleted_at: row.deleted_at,
      delete_reason: row.delete_reason,
    })),
    ...reports.map(row => ({
      record_type: 'violation_report',
      id: row.id,
      registration_id: row.registration_id,
      id_number: row.id_number,
      first_name: row.first_name,
      last_name: row.last_name,
      phone: '',
      license_plate: row.license_plate,
      province: '',
      status: row.status,
      rule_name: row.rule_name,
      description: row.description,
      registered_at: '',
      recorded_at: row.reported_at,
      deleted_at: row.deleted_at,
      delete_reason: row.delete_reason,
    })),
    ...summons.map(row => ({
      record_type: 'summons_appointment',
      id: row.id,
      registration_id: row.registration_id,
      id_number: row.id_number,
      first_name: row.first_name,
      last_name: row.last_name,
      phone: '',
      license_plate: row.license_plate,
      province: '',
      status: row.appointment_code || '',
      rule_name: '',
      description: row.note,
      registered_at: '',
      recorded_at: row.scheduled_at || row.created_at,
      deleted_at: row.deleted_at,
      delete_reason: row.delete_reason,
    })),
  ];
}

// Redirect /data to /data/import
router.get('/', (req, res) => {
  res.redirect('/data/import-export');
});

// GET /data/import-export
router.get('/import-export', async (req, res) => {
  const activeTab = req.query.tab === 'export' ? 'export' : 'import';
  res.render('data/import-export', {
    title: 'นำเข้า-ส่งออก ข้อมูล - BU MotoSpace',
    activeTab,
  });
});

// GET /data/import
router.get('/import', async (req, res) => {
  res.render('data/import-export', {
    title: 'นำเข้า-ส่งออก ข้อมูล - BU MotoSpace',
    activeTab: 'import',
  });
});

// GET /data/export
router.get('/export', async (req, res) => {
  res.render('data/import-export', {
    title: 'นำเข้า-ส่งออก ข้อมูล - BU MotoSpace',
    activeTab: 'export',
  });
});

// GET /data/manage
router.get('/manage', async (req, res) => {
  let conn;
  const limit = 20;
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const filters = buildRegistrationDateFilters(req.query);
  const activeView = getManageView(req.query.view, filters.status);

  try {
    conn = await pool.getConnection();
    const [countResult] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM registrations r ${filters.where}`,
      filters.params
    );
    const filteredRegistrationTotal = Number(countResult && countResult.cnt) || 0;

    const [relatedCount] = filters.hasDateRange ? await conn.query(
      `SELECT COUNT(DISTINCT CASE WHEN v.deleted_at IS NULL THEN v.id END) AS violation_count,
              COUNT(DISTINCT CASE WHEN vr.deleted_at IS NULL THEN vr.id END) AS report_count,
              COUNT(DISTINCT CASE WHEN sa.deleted_at IS NULL THEN sa.id END) AS summons_count
       FROM registrations r
       LEFT JOIN violations v ON v.registration_id = r.id
       LEFT JOIN violation_reports vr ON vr.registration_id = r.id
       LEFT JOIN summons_appointments sa ON sa.registration_id = r.id
       ${filters.where}`,
      filters.params
    ) : [{ violation_count: 0, report_count: 0, summons_count: 0 }];

    const [softDeletedSummary] = await conn.query(
      `SELECT COUNT(*) AS deleted_count
       FROM registrations
       WHERE deleted_at IS NOT NULL`
    );
    const filteredSoftDeletedTotal = activeView === 'deleted'
      ? await countSoftDeletedRows(conn, filters)
      : 0;

    let rows = [];
    let total = 0;
    if (activeView === 'deleted') {
      total = filteredSoftDeletedTotal;
    } else {
      total = filters.hasDateRange ? filteredRegistrationTotal : 0;
    }

    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const currentPage = Math.min(page, totalPages);
    const offset = (currentPage - 1) * limit;

    if (activeView === 'deleted') {
      rows = await fetchSoftDeletedRows(conn, filters, limit, offset);
    } else {
      rows = filters.hasDateRange ? await fetchManagedRegistrations(conn, filters, limit, offset) : [];
    }

    res.render('data/manage', {
      title: 'จัดการข้อมูล - BU MotoSpace',
      rows,
      total,
      totalPages,
      currentPage,
      activeView,
      registeredFrom: filters.registeredFrom,
      registeredTo: filters.registeredTo,
      status: activeView === 'deleted' ? 'deleted' : filters.status,
      registrationCardStatus: filters.status === 'all' ? 'all' : 'active',
      hasDateRange: filters.hasDateRange,
      filteredRegistrationTotal,
      relatedCount: {
        violations: Number(relatedCount && relatedCount.violation_count) || 0,
        reports: Number(relatedCount && relatedCount.report_count) || 0,
        summons: Number(relatedCount && relatedCount.summons_count) || 0,
      },
      summary: {
        deletedCount: Number(softDeletedSummary && softDeletedSummary.deleted_count) || 0,
      },
    });
  } catch (err) {
    console.error('GET /data/manage error:', err);
    req.flash('error', 'ไม่สามารถโหลดหน้าจัดการข้อมูลได้: ' + err.message);
    res.redirect('/data/export');
  } finally {
    if (conn) conn.release();
  }
});

// GET /data/manage/export
router.get('/manage/export', async (req, res) => {
  let conn;
  const filters = buildRegistrationDateFilters(req.query);

  try {
    if (!filters.hasDateRange) {
      req.flash('error', 'กรุณาระบุช่วงวันที่ลงทะเบียนก่อนสำรองข้อมูล');
      return res.redirect('/data/manage');
    }

    conn = await pool.getConnection();
    const registrations = await fetchRegistrationBackups(conn, filters);
    const registrationIds = registrations.map(row => row.id);
    const violations = await fetchViolationBackups(conn, registrationIds);
    const reports = await fetchReportBackups(conn, registrationIds);
    const summons = await fetchSummonsBackups(conn, registrationIds);
    const rows = buildCombinedBackupRows(registrations, violations, reports, summons);
    const fields = [
      'record_type', 'id', 'registration_id', 'id_number', 'first_name', 'last_name', 'phone',
      'license_plate', 'province', 'status', 'rule_name', 'description', 'registered_at',
      'recorded_at', 'deleted_at', 'delete_reason',
    ];
    const parser = new Parser({ fields, withBOM: true });
    const csv = parser.parse(rows);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=data_cleanup_backup_${stamp}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('GET /data/manage/export error:', err);
    req.flash('error', 'ไม่สามารถสำรองข้อมูลได้: ' + err.message);
    res.redirect('/data/manage');
  } finally {
    if (conn) conn.release();
  }
});

// POST /data/manage/delete
router.post('/manage/delete', verifyCsrf, async (req, res) => {
  let conn;
  const deleteType = 'soft';
  const filters = buildRegistrationDateFilters(req.body);
  const reason = (req.body.reason || '').trim();
  const returnUrl = `/data/manage?registered_from=${encodeURIComponent(filters.registeredFrom)}&registered_to=${encodeURIComponent(filters.registeredTo)}&status=${encodeURIComponent(filters.status)}`;

  if (!filters.hasDateRange) {
    req.flash('error', 'กรุณาระบุช่วงวันที่ลงทะเบียนก่อนลบข้อมูล');
    return res.redirect(returnUrl);
  }

  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const registrations = await fetchRegistrationBackups(conn, filters);
    const registrationIds = registrations.map(row => row.id);
    if (!registrationIds.length) {
      await conn.rollback();
      req.flash('error', 'ไม่พบข้อมูลในช่วงวันที่ที่เลือก');
      return res.redirect(returnUrl);
    }

    const violations = await fetchViolationBackups(conn, registrationIds);
    const reports = await fetchReportBackups(conn, registrationIds);
    const summons = await fetchSummonsBackups(conn, registrationIds);
    await logDeletionSnapshots(conn, 'registrations', registrations, deleteType, reason, req.session.admin.id);
    await logDeletionSnapshots(conn, 'violations', violations, deleteType, reason, req.session.admin.id);
    await logDeletionSnapshots(conn, 'violation_reports', reports, deleteType, reason, req.session.admin.id);
    await logDeletionSnapshots(conn, 'summons_appointments', summons, deleteType, reason, req.session.admin.id);

    await conn.query(
      `UPDATE violation_reports
       SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?
       WHERE registration_id IN (${placeholders(registrationIds)}) AND deleted_at IS NULL`,
      [req.session.admin.id, reason || null, ...registrationIds]
    );
    await conn.query(
      `UPDATE summons_appointments
       SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?
       WHERE registration_id IN (${placeholders(registrationIds)}) AND deleted_at IS NULL`,
      [req.session.admin.id, reason || null, ...registrationIds]
    );
    await conn.query(
      `UPDATE violations
       SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?
       WHERE registration_id IN (${placeholders(registrationIds)}) AND deleted_at IS NULL`,
      [req.session.admin.id, reason || null, ...registrationIds]
    );
    await conn.query(
      `UPDATE registrations
       SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?
       WHERE id IN (${placeholders(registrationIds)}) AND deleted_at IS NULL`,
      [req.session.admin.id, reason || null, ...registrationIds]
    );

    await conn.commit();
    req.flash('success', `ลบข้อมูลชั่วคราวสำเร็จ ${registrationIds.length} ทะเบียน, ${violations.length} รายการกระทำผิด, ${reports.length} รายงาน และ ${summons.length} รายการเรียกพบ พร้อมบันทึก snapshot แล้ว`);
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('POST /data/manage/delete error:', err);
    req.flash('error', 'ไม่สามารถลบข้อมูลได้: ' + err.message);
  } finally {
    if (conn) conn.release();
  }

  res.redirect(returnUrl);
});

// POST /data/manage/hard-delete-soft-deleted
router.post('/manage/hard-delete-soft-deleted', verifyCsrf, async (req, res) => {
  let conn;
  const filters = buildRegistrationDateFilters(req.body);
  const reason = (req.body.reason || '').trim();
  const query = new URLSearchParams({ view: 'deleted', status: 'deleted' });
  if (filters.registeredFrom) query.set('registered_from', filters.registeredFrom);
  if (filters.registeredTo) query.set('registered_to', filters.registeredTo);
  const returnUrl = `/data/manage?${query.toString()}`;

  if (req.body.confirm_hard_delete !== 'DELETE') {
    req.flash('error', 'กรุณาพิมพ์ DELETE เพื่อยืนยันการลบถาวร');
    return res.redirect(returnUrl);
  }

  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const snapshots = await fetchSoftDeletedSnapshots(conn, filters);
    if (!snapshots.length) {
      await conn.rollback();
      req.flash('error', 'ยังไม่มีข้อมูลที่ถูกลบชั่วคราวตามเงื่อนไขนี้');
      return res.redirect(returnUrl);
    }

    await logHardDeleteSoftDeletedSnapshots(conn, snapshots, reason, req.session.admin.id);
    const deleted = await hardDeleteSoftDeletedRows(conn, filters);

    await conn.commit();
    req.flash('success', `ลบข้อมูลถาวรสำเร็จ ${deleted.registrations} ทะเบียน พร้อมข้อมูลที่เกี่ยวข้อง`);
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('POST /data/manage/hard-delete-soft-deleted error:', err);
    req.flash('error', 'ไม่สามารถลบข้อมูลที่ถูกลบชั่วคราวแบบถาวรได้: ' + err.message);
  } finally {
    if (conn) conn.release();
  }

  res.redirect(returnUrl);
});

// GET /data/import/template
router.get('/import/template', (req, res) => {
  const wsData = [
    ['ประเภท', 'รหัส', 'ชื่อ', 'นามสกุล', 'โทรศัพท์', 'ป้ายทะเบียน', 'จังหวัด'],
    ['student', '6501234', 'สมชาย', 'ใจดี', '0812345678', 'กข 1234', 'กรุงเทพมหานคร'],
    ['staff', 'T001', 'สมหญิง', 'รักดี', '', '1กข 5678', 'นนทบุรี']
  ];
  
  const ws = xlsx.utils.aoa_to_sheet(wsData);
  
  // Set column widths
  ws['!cols'] = [
    { wch: 10 }, // ประเภท
    { wch: 15 }, // รหัส
    { wch: 20 }, // ชื่อ
    { wch: 20 }, // นามสกุล
    { wch: 15 }, // โทรศัพท์
    { wch: 15 }, // ป้ายทะเบียน
    { wch: 20 }  // จังหวัด
  ];

  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Template');

  const fileBuffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename="registration_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(fileBuffer);
});

// GET /data/export/registrations
router.get('/export/registrations', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      'SELECT id, user_type, id_number, first_name, last_name, phone, license_plate, province, status, registered_at FROM registrations WHERE deleted_at IS NULL ORDER BY registered_at DESC'
    );

    const fields = [
      { label: 'ID', value: 'id' },
      { label: 'ประเภท', value: 'user_type' },
      { label: 'รหัส', value: 'id_number' },
      { label: 'ชื่อ', value: 'first_name' },
      { label: 'นามสกุล', value: 'last_name' },
      { label: 'โทรศัพท์', value: 'phone' },
      { label: 'ป้ายทะเบียน', value: 'license_plate' },
      { label: 'จังหวัด', value: 'province' },
      { label: 'สถานะ', value: 'status' },
      { label: 'วันที่ลงทะเบียน', value: 'registered_at' },
    ];
    const parser = new Parser({ fields, withBOM: true });
    const csv = parser.parse(rows);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=registrations.csv');
    res.send(csv);
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถส่งออกข้อมูลได้');
    res.redirect('/data/export');
  } finally {
    if (conn) conn.release();
  }
});

// GET /data/export/violations
router.get('/export/violations', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT v.id, r.id_number, r.first_name, r.last_name, r.license_plate, ru.rule_name, v.description, v.recorded_at
       FROM violations v
       JOIN registrations r ON v.registration_id = r.id
       JOIN rules ru ON v.rule_id = ru.id
       WHERE v.deleted_at IS NULL
         AND r.deleted_at IS NULL
       ORDER BY v.recorded_at DESC`
    );

    const fields = [
      { label: 'ID', value: 'id' },
      { label: 'รหัส', value: 'id_number' },
      { label: 'ชื่อ', value: 'first_name' },
      { label: 'นามสกุล', value: 'last_name' },
      { label: 'ป้ายทะเบียน', value: 'license_plate' },
      { label: 'กฎที่ฝ่าฝืน', value: 'rule_name' },
      { label: 'รายละเอียด', value: 'description' },
      { label: 'วันที่บันทึก', value: 'recorded_at' },
    ];
    const parser = new Parser({ fields, withBOM: true });
    const csv = parser.parse(rows);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=violations.csv');
    res.send(csv);
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถส่งออกข้อมูลได้');
    res.redirect('/data/export');
  } finally {
    if (conn) conn.release();
  }
});

// POST /data/import/registrations
router.post('/import/registrations', upload.single('file'), verifyCsrf, async (req, res) => {
  if (!req.file) {
    req.flash('error', 'กรุณาเลือกไฟล์');
    return res.redirect('/data/import');
  }

  const results = [];
  let conn;
  try {
    const filePath = req.file.path;
    const fileExt = req.file.originalname.split('.').pop().toLowerCase();

    if (fileExt === 'csv') {
      await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csvParser())
          .on('data', (data) => results.push(data))
          .on('end', resolve)
          .on('error', reject);
      });
    } else if (fileExt === 'xlsx' || fileExt === 'xls') {
      const workbook = xlsx.readFile(filePath, { sheetRows: MAX_IMPORT_ROWS + 1 });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = xlsx.utils.sheet_to_json(sheet);
      results.push(...data);
    } else {
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'รองรับเฉพาะไฟล์ .csv, .xlsx และ .xls เท่านั้น');
      return res.redirect('/data/import');
    }

    if (results.length > MAX_IMPORT_ROWS) {
      upload.cleanupUploadedFiles(req);
      req.flash('error', `นำเข้าได้สูงสุด ${MAX_IMPORT_ROWS} รายการต่อครั้ง`);
      return res.redirect('/data/import');
    }

    conn = await pool.getConnection();
    await ensureVehicleSchema(conn);
    let imported = 0;
    let skipped = 0;

    for (const row of results) {
      try {
        await conn.beginTransaction();
        const userType = (row['ประเภท'] || row.user_type || 'student').trim();
        const idNumber = (row['รหัส'] || row.id_number || '').trim();
        const firstName = (row['ชื่อ'] || row.first_name || '').trim();
        const lastName = (row['นามสกุล'] || row.last_name || '').trim();
        const phone = (row['โทรศัพท์'] || row.phone || '').trim();
        const licensePlate = (row['ป้ายทะเบียน'] || row.license_plate || '').trim();
        const province = (row['จังหวัด'] || row.province || '').trim();

        if (!idNumber || !firstName || !lastName || !licensePlate || !province) {
          throw new Error('missing_required_registration_fields');
        }

        const normalizedPlate = await assertPlateAvailable(conn, licensePlate);
        const result = await conn.query(
          `INSERT INTO registrations (user_type, id_number, first_name, last_name, phone, license_plate, province, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
          [userType, idNumber, firstName, lastName, phone, licensePlate, province]
        );
        const sourceRegistrationId = Number(result.insertId);
        const ownerRegistrationId = await findCanonicalOwnerRegistrationId(conn, userType, idNumber, sourceRegistrationId);
        await conn.query(
          `INSERT INTO vehicles (owner_registration_id, source_registration_id, license_plate, normalized_plate, province, status)
           VALUES (?, ?, ?, ?, ?, 'pending')`,
          [ownerRegistrationId, sourceRegistrationId, licensePlate, normalizedPlate, province]
        );
        await conn.commit();
        imported++;
      } catch (e) {
        await conn.rollback().catch(() => {});
        skipped++;
      }
    }

    // Cleanup temp file
    upload.cleanupUploadedFiles(req);

    req.flash('success', `นำเข้าสำเร็จ ${imported} รายการ, ข้าม ${skipped} รายการ (อาจเป็นข้อมูลซ้ำ)`);
  } catch (err) {
    console.error(err);
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'เกิดข้อผิดพลาดในการนำเข้าข้อมูล. โปรดตรวจสอบรูปแบบไฟล์');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/data/import');
});

module.exports = router;
