const router = require('express').Router();
const pool = require('../config/database');
const upload = require('../middleware/upload');
const { isAuthenticated, isHead } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/csrf');
const { generateHash, compareHashes } = require('../utils/imageHash');
const { ensureVehicleSchema, assertPlateAvailable, normalizePlate, findCanonicalOwnerRegistrationId } = require('../utils/vehicles');

router.use(isAuthenticated);

const VEHICLE_STATUSES = new Set(['pending', 'approved', 'rejected']);

async function getRegistrationForVehicleAdmin(conn, registrationId) {
  const [reg] = await conn.query(
    `SELECT id, user_type, id_number, first_name, last_name, phone, license_plate, id_card_photo
     FROM registrations
     WHERE id = ? AND deleted_at IS NULL`,
    [registrationId]
  );
  return reg || null;
}

async function getOwnerRegistrationIdForAdmin(conn, reg) {
  return findCanonicalOwnerRegistrationId(conn, reg.user_type, reg.id_number, Number(reg.id));
}

async function getRelatedRegistrationIdsForUser(conn, reg) {
  const currentId = Number(reg.id);
  const ids = new Set();
  if (Number.isFinite(currentId)) ids.add(currentId);

  const initialRows = await conn.query(
    `SELECT id
     FROM registrations
     WHERE user_type = ?
       AND id_number = ?
     ORDER BY id ASC`,
    [reg.user_type, reg.id_number]
  );
  initialRows
    .map(row => Number(row.id))
    .filter(Number.isFinite)
    .forEach(id => ids.add(id));

  let changed = true;
  while (changed) {
    changed = false;
    const currentIds = [...ids];
    const placeholders = sqlPlaceholders(currentIds);

    const identityRows = await conn.query(
      `SELECT DISTINCT r2.id
       FROM registrations r1
       JOIN registrations r2
         ON r2.user_type = r1.user_type
        AND r2.id_number = r1.id_number
       WHERE r1.id IN (${placeholders})`,
      currentIds
    );
    identityRows.forEach(row => {
      const id = Number(row.id);
      if (Number.isFinite(id) && !ids.has(id)) {
        ids.add(id);
        changed = true;
      }
    });

    const vehicleRows = await conn.query(
      `SELECT owner_registration_id, source_registration_id
       FROM vehicles
       WHERE owner_registration_id IN (${placeholders})
          OR source_registration_id IN (${placeholders})`,
      [...currentIds, ...currentIds]
    );
    vehicleRows.forEach(row => {
      [row.owner_registration_id, row.source_registration_id].forEach(value => {
        const id = Number(value);
        if (Number.isFinite(id) && !ids.has(id)) {
          ids.add(id);
          changed = true;
        }
      });
    });
  }

  return [...ids].sort((a, b) => a - b);
}

function sqlPlaceholders(values) {
  return values.map(() => '?').join(', ');
}

function sqlNormalizeCompactExpression(columnName) {
  return `UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(${columnName}), ' ', ''), CHAR(9), ''), CHAR(10), ''), CHAR(13), ''), CHAR(160), ''))`;
}

function vehiclePlateSearchCondition(vehicleAlias) {
  return `EXISTS (
    SELECT 1
    FROM vehicles ${vehicleAlias}
    WHERE ${vehicleAlias}.owner_registration_id = r.id
      AND (${vehicleAlias}.source_registration_id IS NULL OR ${vehicleAlias}.source_registration_id = r.id)
      AND ${vehicleAlias}.deleted_at IS NULL
      AND (
        ${vehicleAlias}.license_plate LIKE ? OR
        ${vehicleAlias}.normalized_plate LIKE ? OR
        ${sqlNormalizeCompactExpression(`${vehicleAlias}.license_plate`)} LIKE ?
      )
  )`;
}

function publicVehiclePredicate(vehicleAlias, registrationAlias = 'r') {
  return `${vehicleAlias}.deleted_at IS NULL
      AND (
        ${vehicleAlias}.source_registration_id = ${registrationAlias}.id
        OR (
          ${vehicleAlias}.owner_registration_id = ${registrationAlias}.id
          AND ${vehicleAlias}.source_registration_id IS NULL
          AND ${vehicleAlias}.created_by IS NULL
        )
      )`;
}

function effectiveRegistrationStatusExpression(registrationAlias = 'r') {
  return `CASE
    WHEN EXISTS (
      SELECT 1 FROM vehicles ev_pending
      WHERE ${publicVehiclePredicate('ev_pending', registrationAlias)}
        AND ev_pending.status = 'pending'
    ) THEN 'pending'
    WHEN EXISTS (
      SELECT 1 FROM vehicles ev_rejected
      WHERE ${publicVehiclePredicate('ev_rejected', registrationAlias)}
        AND ev_rejected.status = 'rejected'
    ) THEN 'rejected'
    WHEN EXISTS (
      SELECT 1 FROM vehicles ev_any
      WHERE ${publicVehiclePredicate('ev_any', registrationAlias)}
    )
    AND NOT EXISTS (
      SELECT 1 FROM vehicles ev_open
      WHERE ${publicVehiclePredicate('ev_open', registrationAlias)}
        AND ev_open.status <> 'approved'
    ) THEN 'approved'
    ELSE ${registrationAlias}.status
  END`;
}

async function syncRegistrationStatusFromPublicVehicles(conn, registrationId, adminId, notes = null) {
  const [reg] = await conn.query(
    'SELECT id FROM registrations WHERE id = ? AND deleted_at IS NULL',
    [registrationId]
  );
  if (!reg) return;

  const vehicles = await conn.query(
    `SELECT status
     FROM vehicles
     WHERE deleted_at IS NULL
       AND (
         source_registration_id = ?
         OR (
           owner_registration_id = ?
           AND source_registration_id IS NULL
           AND created_by IS NULL
         )
       )`,
    [registrationId, registrationId]
  );

  if (!vehicles.length) return;

  let nextStatus = 'pending';
  if (vehicles.some(vehicle => vehicle.status === 'pending')) {
    nextStatus = 'pending';
  } else if (vehicles.some(vehicle => vehicle.status === 'rejected')) {
    nextStatus = 'rejected';
  } else if (vehicles.every(vehicle => vehicle.status === 'approved')) {
    nextStatus = 'approved';
  }

  if (nextStatus === 'approved') {
    await conn.query(
      `UPDATE registrations
       SET status = 'approved', approved_by = ?, approved_at = NOW()
       WHERE id = ?`,
      [adminId, registrationId]
    );
  } else if (nextStatus === 'rejected') {
    await conn.query(
      `UPDATE registrations
       SET status = 'rejected', notes = COALESCE(?, notes), approved_by = ?, approved_at = NOW()
       WHERE id = ?`,
      [notes || null, adminId, registrationId]
    );
  } else {
    await conn.query(
      `UPDATE registrations
       SET status = 'pending', approved_by = NULL, approved_at = NULL
       WHERE id = ?`,
      [registrationId]
    );
  }
}

async function syncSourceRegistrationAfterVehicleDelete(conn, vehicle, adminId, reason) {
  const sourceRegistrationId = Number(
    vehicle && (vehicle.source_registration_id || (vehicle.created_by == null ? vehicle.owner_registration_id : null))
  );
  if (!Number.isFinite(sourceRegistrationId) || sourceRegistrationId <= 0) return;

  const [replacementVehicle] = await conn.query(
    `SELECT license_plate, province, motorcycle_photo, plate_photo, notes
     FROM vehicles
     WHERE deleted_at IS NULL
       AND (
         source_registration_id = ?
         OR (
           owner_registration_id = ?
           AND source_registration_id IS NULL
           AND created_by IS NULL
         )
       )
     ORDER BY source_registration_id IS NULL ASC, created_at ASC, id ASC
     LIMIT 1`,
    [sourceRegistrationId, sourceRegistrationId]
  );

  if (!replacementVehicle) {
    await conn.query(
      `UPDATE registrations
       SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [adminId, reason, sourceRegistrationId]
    );
    return;
  }

  await conn.query(
    `UPDATE registrations
     SET license_plate = ?, province = ?, motorcycle_photo = ?, plate_photo = ?, notes = COALESCE(?, notes)
     WHERE id = ? AND deleted_at IS NULL`,
    [
      replacementVehicle.license_plate,
      replacementVehicle.province,
      replacementVehicle.motorcycle_photo,
      replacementVehicle.plate_photo,
      replacementVehicle.notes || null,
      sourceRegistrationId,
    ]
  );

  await syncRegistrationStatusFromPublicVehicles(conn, Number(sourceRegistrationId), adminId);
}

function matchedVehiclePlateJoin(joinAlias, subqueryAlias) {
  return `LEFT JOIN vehicles ${joinAlias} ON ${joinAlias}.id = (
    SELECT ${subqueryAlias}.id
    FROM vehicles ${subqueryAlias}
    WHERE ${subqueryAlias}.owner_registration_id = r.id
      AND (${subqueryAlias}.source_registration_id IS NULL OR ${subqueryAlias}.source_registration_id = r.id)
      AND ${subqueryAlias}.deleted_at IS NULL
      AND (
        ${subqueryAlias}.license_plate LIKE ? OR
        ${subqueryAlias}.normalized_plate LIKE ? OR
        ${sqlNormalizeCompactExpression(`${subqueryAlias}.license_plate`)} LIKE ?
      )
    ORDER BY ${subqueryAlias}.source_registration_id IS NULL DESC, ${subqueryAlias}.created_at DESC, ${subqueryAlias}.id DESC
    LIMIT 1
  )`;
}

function getDuplicatePlateMessage(err) {
  if (err && err.code === 'DUPLICATE_PLATE') {
    const duplicate = err.duplicate || {};
    const ownerName = duplicate.ownerName || 'ไม่พบชื่อเจ้าของ';
    const idNumber = duplicate.idNumber ? ` รหัส ${duplicate.idNumber}` : '';
    const plate = duplicate.licensePlate ? ` (${duplicate.licensePlate}${duplicate.province ? ' ' + duplicate.province : ''})` : '';
    return `ข้อมูลทะเบียนนี้ได้มีการลงทะเบียนไว้แล้ว ในชื่อ ${ownerName}${idNumber}${plate}`;
  }
  return err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)
    ? 'ข้อมูลทะเบียนนี้ได้มีการลงทะเบียนไว้แล้ว'
    : 'ข้อมูลทะเบียนรถไม่ถูกต้อง';
}

function flashDuplicatePlatePopup(req, err) {
  const message = getDuplicatePlateMessage(err);
  if (err && (err.code === 'DUPLICATE_PLATE' || err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) {
    req.flash('duplicatePlatePopup', message);
  } else {
    req.flash('error', message);
  }
}

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
    await ensureVehicleSchema(conn);
    const { search, type, status, page = 1 } = req.query;
    const limit = 20;
    const offset = (page - 1) * limit;
    const isDeletedView = status === 'deleted';
    const publicRegistrationOnlySql = `
      NOT EXISTS (
        SELECT 1
        FROM vehicles vx
        WHERE vx.source_registration_id = r.id
          AND vx.created_by IS NOT NULL
      )`;

    let where = isDeletedView
      ? `WHERE r.deleted_at IS NOT NULL AND ${publicRegistrationOnlySql}`
      : `WHERE r.deleted_at IS NULL AND ${publicRegistrationOnlySql}`;
    const params = [];
    let vehicleSearchJoin = '';
    const vehicleSearchJoinParams = [];
    let licensePlateSelect = 'r.license_plate';
    let provinceSelect = 'r.province';
    const effectiveStatusSql = effectiveRegistrationStatusExpression('r');

    if (search) {
      // Normalize: trim and collapse multiple spaces for reliable matching
      const searchTrimmed = search.trim().replace(/\s+/g, ' ');
      const s = `%${searchTrimmed}%`;
      // Also search by combined full name (first_name + space + last_name)
      const sName = `%${searchTrimmed}%`;
      const sNoSpace = `%${normalizePlate(searchTrimmed)}%`;
      vehicleSearchJoin = matchedVehiclePlateJoin('search_v', 'svj');
      vehicleSearchJoinParams.push(s, sNoSpace, sNoSpace);
      licensePlateSelect = 'COALESCE(search_v.license_plate, r.license_plate)';
      provinceSelect = 'COALESCE(search_v.province, r.province)';
      where += ` AND (
        r.id_number LIKE ? OR
        r.first_name LIKE ? OR
        r.last_name LIKE ? OR
        CONCAT(r.first_name, ' ', r.last_name) LIKE ? OR
        r.license_plate LIKE ? OR
        ${sqlNormalizeCompactExpression('r.license_plate')} LIKE ? OR
        r.phone LIKE ? OR
        ${vehiclePlateSearchCondition('sv')}
      )`;
      params.push(s, s, s, sName, s, sNoSpace, s, s, sNoSpace, sNoSpace);
    }
    if (type) { where += ' AND r.user_type = ?'; params.push(type); }
    if (status && !isDeletedView) { where += ` AND (${effectiveStatusSql}) = ?`; params.push(status); }

    const [countResult] = await conn.query(`SELECT COUNT(*) as cnt FROM registrations r ${where}`, params);
    const total = parseInt(countResult.cnt);
    const totalPages = Math.ceil(total / limit);

    const rows = await conn.query(
      `SELECT r.id, r.id_number, r.user_type, r.first_name, r.last_name, r.phone,
              ${licensePlateSelect} AS license_plate,
              ${provinceSelect} AS province,
              ${effectiveStatusSql} AS status, r.registered_at, r.deleted_at, r.delete_reason,
              a.full_name AS deleted_by_name,
              ap.full_name AS approved_by_name
       FROM registrations r
       LEFT JOIN admins a ON r.deleted_by = a.id
       LEFT JOIN admins ap ON r.approved_by = ap.id
       ${vehicleSearchJoin}
       ${where}
       ORDER BY ${isDeletedView ? 'r.deleted_at' : 'r.registered_at'} DESC
       LIMIT ? OFFSET ?`,
      [...vehicleSearchJoinParams, ...params, limit, offset]
    );

    // Pick up image search results from session (set by POST /search)
    const imageSearchResults = req.session.imageSearchResults || null;
    if (req.session.imageSearchResults) delete req.session.imageSearchResults;

    // Summary counts for cards
    const [totalRegResult] = await conn.query(
      `SELECT COUNT(*) as cnt
       FROM registrations r
       WHERE r.deleted_at IS NULL AND ${publicRegistrationOnlySql}`
    );
    const [deletedRegResult] = await conn.query(
      `SELECT COUNT(*) as cnt
       FROM registrations r
       WHERE r.deleted_at IS NOT NULL AND ${publicRegistrationOnlySql}`
    );
    const totalRegistrations = parseInt(totalRegResult.cnt);
    const deletedCount = parseInt(deletedRegResult.cnt);

    // Per-status counts
    const statusRows = await conn.query(
      `SELECT ${effectiveStatusSql} AS status, COUNT(*) as cnt
       FROM registrations r
       WHERE r.deleted_at IS NULL AND ${publicRegistrationOnlySql}
       GROUP BY status`
    );
    const statusCountMap = { pending: 0, approved: 0, rejected: 0 };
    statusRows.forEach(r => { statusCountMap[r.status] = parseInt(r.cnt); });

    const pageTitle = status === 'pending' ? 'ตรวจสอบการลงทะเบียนใหม่' : isDeletedView ? 'ข้อมูลทะเบียนที่ถูกลบชั่วคราว' : 'จัดการทะเบียน';

    res.render('registrations/index', {
      title: `${pageTitle} - BU MotoSpace`,
      registrations: rows,
      total,
      totalPages,
      currentPage: parseInt(page),
      search: search || '',
      type: type || '',
      status: status || '',
      isDeletedView,
      imageSearchResults,
      totalRegistrations,
      deletedCount,
      statusCountMap,
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
      isDeletedView: req.query.status === 'deleted',
      imageSearchResults: null,
      totalRegistrations: 0,
      deletedCount: 0,
      statusCountMap: { pending: 0, approved: 0, rejected: 0 },
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
    await ensureVehicleSchema(conn);
    const { q } = req.query;
    if (!q || !q.trim()) return res.json([]);

    const searchTrimmed = q.trim().replace(/\s+/g, ' ');
    const s = `%${searchTrimmed}%`;
    const sNoSpace = `%${normalizePlate(searchTrimmed)}%`;
    const vehicleSearchJoin = matchedVehiclePlateJoin('search_v', 'svj');

    const rows = await conn.query(
      `SELECT r.id, r.id_number, r.user_type, r.first_name, r.last_name, r.phone,
              COALESCE(search_v.license_plate, r.license_plate) AS license_plate,
              COALESCE(search_v.province, r.province) AS province,
              r.status
       FROM registrations r
       ${vehicleSearchJoin}
       WHERE r.deleted_at IS NULL AND (
         r.id_number LIKE ? OR
         r.first_name LIKE ? OR
         r.last_name LIKE ? OR
         CONCAT(r.first_name, ' ', r.last_name) LIKE ? OR
         r.license_plate LIKE ? OR
         ${sqlNormalizeCompactExpression('r.license_plate')} LIKE ? OR
         r.phone LIKE ? OR
         ${vehiclePlateSearchCondition('sv')}
       )
       ORDER BY r.registered_at DESC LIMIT 10`,
      [s, sNoSpace, sNoSpace, s, s, s, s, s, sNoSpace, s, s, sNoSpace, sNoSpace]
    );
    return res.json(rows);
  } catch (err) {
    console.error('AJAX search error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (conn) conn.release();
  }
});

// GET /registrations/:id/vehicles — Admin JSON list for one owner
router.get('/:id/vehicles', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureVehicleSchema(conn);

    const reg = await getRegistrationForVehicleAdmin(conn, req.params.id);
    if (!reg) return res.status(404).json({ error: 'registration_not_found' });
    const ownerRegistrationId = await getOwnerRegistrationIdForAdmin(conn, reg);

    const vehicles = await conn.query(
      `SELECT v.*,
              a.full_name AS approved_by_name,
              d.full_name AS deleted_by_name
       FROM vehicles v
       LEFT JOIN admins a ON v.approved_by = a.id
       LEFT JOIN admins d ON v.deleted_by = d.id
       WHERE v.owner_registration_id = ? OR v.source_registration_id = ?
       ORDER BY v.deleted_at IS NULL DESC, v.created_at ASC, v.id ASC`,
      [ownerRegistrationId, req.params.id]
    );

    return res.json({ vehicles });
  } catch (err) {
    console.error('GET /registrations/:id/vehicles error:', err);
    return res.status(500).json({ error: 'internal_server_error' });
  } finally {
    if (conn) conn.release();
  }
});

// POST /registrations/:id/vehicles — Admin adds another vehicle to this user
router.post('/:id/vehicles', isHead, upload.fields([
  { name: 'motorcycle_photo', maxCount: 1 },
  { name: 'plate_photo', maxCount: 1 },
]), verifyCsrf, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureVehicleSchema(conn);
    await conn.beginTransaction();

    const reg = await getRegistrationForVehicleAdmin(conn, req.params.id);
    if (!reg) {
      await conn.rollback();
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'ไม่พบข้อมูลผู้ใช้ที่ต้องการเพิ่มรถ');
      return res.redirect('/registrations');
    }

    const licensePlate = (req.body.license_plate || '').trim();
    const province = (req.body.province || '').trim();
    const status = VEHICLE_STATUSES.has(req.body.status) ? req.body.status : 'pending';
    const notes = (req.body.notes || '').trim() || null;

    if (!licensePlate || !province) {
      await conn.rollback();
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'กรุณากรอกทะเบียนรถและจังหวัดให้ครบถ้วน');
      return res.redirect('/registrations/' + req.params.id);
    }

    let normalizedPlate;
    try {
      normalizedPlate = await assertPlateAvailable(conn, licensePlate);
    } catch (err) {
      await conn.rollback();
      upload.cleanupUploadedFiles(req);
      flashDuplicatePlatePopup(req, err);
      return res.redirect('/registrations/' + req.params.id);
    }

    const motorcyclePhoto = req.files && req.files.motorcycle_photo ? '/uploads/motorcycles/' + req.files.motorcycle_photo[0].filename : null;
    const platePhoto = req.files && req.files.plate_photo ? '/uploads/plates/' + req.files.plate_photo[0].filename : null;
    const approvedBy = status === 'approved' ? req.session.admin.id : null;
    const ownerRegistrationId = await getOwnerRegistrationIdForAdmin(conn, reg);

    await conn.query(
      `INSERT INTO vehicles (
        owner_registration_id,
        source_registration_id,
        license_plate,
        normalized_plate,
        province,
        motorcycle_photo,
        plate_photo,
        status,
        notes,
        created_by,
        approved_by,
        approved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${status === 'approved' ? 'NOW()' : 'NULL'})`,
      [ownerRegistrationId, null, licensePlate, normalizedPlate, province, motorcyclePhoto, platePhoto, status, notes, req.session.admin.id, approvedBy]
    );

    if (req.files && req.files.motorcycle_photo) {
      const hash = await generateHash(req.files.motorcycle_photo[0].path);
      if (hash) {
        await conn.query(
          'INSERT INTO image_hashes (registration_id, image_type, phash, file_path) VALUES (?, ?, ?, ?)',
          [ownerRegistrationId, 'motorcycle', hash, motorcyclePhoto]
        );
      }
    }
    if (req.files && req.files.plate_photo) {
      const hash = await generateHash(req.files.plate_photo[0].path);
      if (hash) {
        await conn.query(
          'INSERT INTO image_hashes (registration_id, image_type, phash, file_path) VALUES (?, ?, ?, ?)',
          [ownerRegistrationId, 'plate', hash, platePhoto]
        );
      }
    }

    await conn.commit();
    req.flash('success', 'เพิ่มรถให้ผู้ใช้นี้เรียบร้อยแล้ว');
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('POST /registrations/:id/vehicles error:', err);
    upload.cleanupUploadedFiles(req);
    if (err && (err.code === 'DUPLICATE_PLATE' || err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) {
      flashDuplicatePlatePopup(req, err);
    } else {
      req.flash('error', 'ไม่สามารถเพิ่มรถได้');
    }
  } finally {
    if (conn) conn.release();
  }

  return res.redirect('/registrations/' + req.params.id + '#vehicles');
});

// POST /registrations/:id/vehicles/:vehicleId/edit — Admin edits one vehicle
router.post('/:id/vehicles/:vehicleId/edit', isHead, upload.fields([
  { name: 'motorcycle_photo', maxCount: 1 },
  { name: 'plate_photo', maxCount: 1 },
]), verifyCsrf, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureVehicleSchema(conn);
    await conn.beginTransaction();

    const [vehicle] = await conn.query(
      `SELECT * FROM vehicles
       WHERE id = ?
         AND (owner_registration_id = ? OR source_registration_id = ?)
         AND deleted_at IS NULL`,
      [req.params.vehicleId, req.params.id, req.params.id]
    );

    if (!vehicle) {
      await conn.rollback();
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'ไม่พบข้อมูลรถที่ต้องการแก้ไข');
      return res.redirect('/registrations/' + req.params.id);
    }

    const licensePlate = (req.body.license_plate || '').trim();
    const province = (req.body.province || '').trim();
    const status = VEHICLE_STATUSES.has(req.body.status) ? req.body.status : vehicle.status;
    const notes = (req.body.notes || '').trim() || null;

    if (!licensePlate || !province) {
      await conn.rollback();
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'กรุณากรอกทะเบียนรถและจังหวัดให้ครบถ้วน');
      return res.redirect('/registrations/' + req.params.id);
    }

    let normalizedPlate;
    try {
      normalizedPlate = await assertPlateAvailable(conn, licensePlate, req.params.vehicleId);
    } catch (err) {
      await conn.rollback();
      upload.cleanupUploadedFiles(req);
      flashDuplicatePlatePopup(req, err);
      return res.redirect('/registrations/' + req.params.id);
    }

    let sql = `UPDATE vehicles
       SET license_plate = ?, normalized_plate = ?, province = ?, status = ?, notes = ?`;
    const params = [licensePlate, normalizedPlate, province, status, notes];

    if (status === 'approved') {
      sql += ', approved_by = ?, approved_at = NOW()';
      params.push(req.session.admin.id);
    }
    if (req.files && req.files.motorcycle_photo) {
      sql += ', motorcycle_photo = ?';
      params.push('/uploads/motorcycles/' + req.files.motorcycle_photo[0].filename);
    }
    if (req.files && req.files.plate_photo) {
      sql += ', plate_photo = ?';
      params.push('/uploads/plates/' + req.files.plate_photo[0].filename);
    }

    sql += ' WHERE id = ? AND (owner_registration_id = ? OR source_registration_id = ?)';
    params.push(req.params.vehicleId, req.params.id, req.params.id);
    await conn.query(sql, params);

    if (vehicle.source_registration_id) {
      await conn.query(
        `UPDATE registrations
         SET license_plate = ?, province = ?, notes = ?
         WHERE id = ?`,
        [licensePlate, province, notes, vehicle.source_registration_id]
      );

      if (req.files && req.files.motorcycle_photo) {
        const filePath = '/uploads/motorcycles/' + req.files.motorcycle_photo[0].filename;
        const hash = await generateHash(req.files.motorcycle_photo[0].path);
        await conn.query(
          'DELETE FROM image_hashes WHERE registration_id = ? AND image_type = ?',
          [vehicle.source_registration_id, 'motorcycle']
        );
        if (hash) {
          await conn.query(
            'INSERT INTO image_hashes (registration_id, image_type, phash, file_path) VALUES (?, ?, ?, ?)',
            [vehicle.source_registration_id, 'motorcycle', hash, filePath]
          );
        }
      }
      if (req.files && req.files.plate_photo) {
        const filePath = '/uploads/plates/' + req.files.plate_photo[0].filename;
        const hash = await generateHash(req.files.plate_photo[0].path);
        await conn.query(
          'DELETE FROM image_hashes WHERE registration_id = ? AND image_type = ?',
          [vehicle.source_registration_id, 'plate']
        );
        if (hash) {
          await conn.query(
            'INSERT INTO image_hashes (registration_id, image_type, phash, file_path) VALUES (?, ?, ?, ?)',
            [vehicle.source_registration_id, 'plate', hash, filePath]
          );
        }
      }
    }

    if (!vehicle.source_registration_id) {
      const imageHashRegistrationId = vehicle.owner_registration_id;
      if (req.files && req.files.motorcycle_photo) {
        const filePath = '/uploads/motorcycles/' + req.files.motorcycle_photo[0].filename;
        const hash = await generateHash(req.files.motorcycle_photo[0].path);
        if (hash) {
          await conn.query(
            'INSERT INTO image_hashes (registration_id, image_type, phash, file_path) VALUES (?, ?, ?, ?)',
            [imageHashRegistrationId, 'motorcycle', hash, filePath]
          );
        }
      }
      if (req.files && req.files.plate_photo) {
        const filePath = '/uploads/plates/' + req.files.plate_photo[0].filename;
        const hash = await generateHash(req.files.plate_photo[0].path);
        if (hash) {
          await conn.query(
            'INSERT INTO image_hashes (registration_id, image_type, phash, file_path) VALUES (?, ?, ?, ?)',
            [imageHashRegistrationId, 'plate', hash, filePath]
          );
        }
      }
    }

    await syncRegistrationStatusFromPublicVehicles(
      conn,
      Number(vehicle.source_registration_id || vehicle.owner_registration_id),
      req.session.admin.id,
      notes
    );

    await conn.commit();
    req.flash('success', 'แก้ไขข้อมูลรถเรียบร้อยแล้ว');
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('POST /registrations/:id/vehicles/:vehicleId/edit error:', err);
    upload.cleanupUploadedFiles(req);
    if (err && (err.code === 'DUPLICATE_PLATE' || err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) {
      flashDuplicatePlatePopup(req, err);
    } else {
      req.flash('error', 'ไม่สามารถแก้ไขข้อมูลรถได้');
    }
  } finally {
    if (conn) conn.release();
  }

  return res.redirect('/registrations/' + req.params.id + '#vehicles');
});

router.post('/:id/vehicles/:vehicleId/approve', isHead, verifyCsrf, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureVehicleSchema(conn);
    await conn.beginTransaction();

    const [vehicle] = await conn.query(
      `SELECT owner_registration_id, source_registration_id
       FROM vehicles
       WHERE id = ?
         AND (owner_registration_id = ? OR source_registration_id = ?)
         AND deleted_at IS NULL`,
      [req.params.vehicleId, req.params.id, req.params.id]
    );
    if (!vehicle) {
      await conn.rollback();
      req.flash('error', 'ไม่พบข้อมูลรถที่ต้องการอนุมัติ');
      return res.redirect('/registrations/' + req.params.id);
    }

    await conn.query(
      `UPDATE vehicles
       SET status = 'approved', approved_by = ?, approved_at = NOW()
       WHERE id = ? AND (owner_registration_id = ? OR source_registration_id = ?)`,
      [req.session.admin.id, req.params.vehicleId, req.params.id, req.params.id]
    );
    await syncRegistrationStatusFromPublicVehicles(
      conn,
      Number(vehicle.source_registration_id || vehicle.owner_registration_id),
      req.session.admin.id
    );
    await conn.commit();
    req.flash('success', 'อนุมัติรถเรียบร้อยแล้ว');
  } catch (err) {
    if (conn) await conn.rollback();
    console.error(err);
    req.flash('error', 'ไม่สามารถอนุมัติรถได้');
  } finally {
    if (conn) conn.release();
  }
  return res.redirect('/registrations/' + req.params.id + '#vehicles');
});

router.post('/:id/vehicles/:vehicleId/reject', isHead, verifyCsrf, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureVehicleSchema(conn);
    await conn.beginTransaction();

    const note = (req.body.notes || '').trim();
    const [vehicle] = await conn.query(
      `SELECT owner_registration_id, source_registration_id
       FROM vehicles
       WHERE id = ?
         AND (owner_registration_id = ? OR source_registration_id = ?)
         AND deleted_at IS NULL`,
      [req.params.vehicleId, req.params.id, req.params.id]
    );
    if (!vehicle) {
      await conn.rollback();
      req.flash('error', 'ไม่พบข้อมูลรถที่ต้องการปฏิเสธ');
      return res.redirect('/registrations/' + req.params.id);
    }

    await conn.query(
      `UPDATE vehicles
       SET status = 'rejected', notes = ?, approved_by = ?, approved_at = NOW()
       WHERE id = ? AND (owner_registration_id = ? OR source_registration_id = ?)`,
      [note, req.session.admin.id, req.params.vehicleId, req.params.id, req.params.id]
    );
    await syncRegistrationStatusFromPublicVehicles(
      conn,
      Number(vehicle.source_registration_id || vehicle.owner_registration_id),
      req.session.admin.id,
      note
    );
    await conn.commit();
    req.flash('success', 'ปฏิเสธรถเรียบร้อยแล้ว');
  } catch (err) {
    if (conn) await conn.rollback();
    console.error(err);
    req.flash('error', 'ไม่สามารถปฏิเสธรถได้');
  } finally {
    if (conn) conn.release();
  }
  return res.redirect('/registrations/' + req.params.id + '#vehicles');
});

router.post('/:id/vehicles/:vehicleId/delete', isHead, verifyCsrf, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureVehicleSchema(conn);
    const reason = (req.body.delete_reason || '').trim();
    if (!reason) {
      req.flash('error', 'กรุณาระบุหมายเหตุในการลบรถ');
      return res.redirect('/registrations/' + req.params.id);
    }

    await conn.beginTransaction();
    const [vehicle] = await conn.query(
      `SELECT owner_registration_id, source_registration_id, created_by
       FROM vehicles
       WHERE id = ?
         AND (owner_registration_id = ? OR source_registration_id = ?)
         AND deleted_at IS NULL
       FOR UPDATE`,
      [req.params.vehicleId, req.params.id, req.params.id]
    );

    if (!vehicle) {
      await conn.rollback();
      req.flash('error', 'ไม่พบข้อมูลรถ หรือรถถูกลบชั่วคราวแล้ว');
      return res.redirect('/registrations/' + req.params.id);
    }

    await conn.query(
      `UPDATE vehicles
       SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?
       WHERE id = ?
         AND (owner_registration_id = ? OR source_registration_id = ?)
         AND deleted_at IS NULL`,
      [req.session.admin.id, reason, req.params.vehicleId, req.params.id, req.params.id]
    );
    await syncSourceRegistrationAfterVehicleDelete(conn, vehicle, req.session.admin.id, reason);
    await conn.commit();
    req.flash('success', 'ลบรถชั่วคราวเรียบร้อยแล้ว');
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error(err);
    req.flash('error', 'ไม่สามารถลบรถได้');
  } finally {
    if (conn) conn.release();
  }
  return res.redirect('/registrations/' + req.params.id + '#vehicles');
});

// GET /registrations/:id

router.get('/:id', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureVehicleSchema(conn);
    const [reg] = await conn.query(
      `SELECT r.*, ${effectiveRegistrationStatusExpression('r')} AS effective_status,
              a.full_name AS deleted_by_name,
              ap.full_name AS approved_by_name
       FROM registrations r
       LEFT JOIN admins a ON r.deleted_by = a.id
       LEFT JOIN admins ap ON r.approved_by = ap.id
       WHERE r.id = ?`,
      [req.params.id]
    );
    if (!reg) {
      req.flash('error', 'ไม่พบข้อมูล');
      return res.redirect('/registrations');
    }
    reg.status = reg.effective_status || reg.status;
    const relatedRegistrationIds = await getRelatedRegistrationIdsForUser(conn, reg);
    const relatedRegistrationPlaceholders = sqlPlaceholders(relatedRegistrationIds);

    const vehicles = await conn.query(
      `SELECT v.*,
              a.full_name AS approved_by_name,
              d.full_name AS deleted_by_name
       FROM vehicles v
       LEFT JOIN admins a ON v.approved_by = a.id
       LEFT JOIN admins d ON v.deleted_by = d.id
       WHERE v.owner_registration_id = ? OR v.source_registration_id = ?
       ORDER BY v.deleted_at IS NULL DESC, v.created_at ASC, v.id ASC`,
      [await getOwnerRegistrationIdForAdmin(conn, reg), req.params.id]
    );

    const violations = await conn.query(
      `SELECT v.*,
              DATE_FORMAT(v.recorded_at, '%Y-%m-%dT%H:%i') AS recorded_at_input,
              CONCAT('IR-', COALESCE(NULLIF(vt.type_code, ''), 'GEN'), '-', LPAD(v.id, 6, '0')) AS incident_code,
              ru.rule_name, ru.max_violations,
              COALESCE(vt.type_name, ru.rule_name) AS violation_type_name,
              vrg.license_plate AS violation_license_plate,
              vrg.province AS violation_province,
              a.full_name as recorded_by_name,
              rpa.full_name as reported_by_name
       FROM violations v
       JOIN registrations vrg ON v.registration_id = vrg.id
       JOIN rules ru ON v.rule_id = ru.id
       LEFT JOIN violation_types vt ON ru.violation_type_id = vt.id
       JOIN admins a ON v.recorded_by = a.id
       LEFT JOIN violation_reports vr ON vr.violation_id = v.id
       LEFT JOIN admins rpa ON vr.reported_by = rpa.id
       WHERE v.registration_id IN (${relatedRegistrationPlaceholders})
         AND v.deleted_at IS NULL
       ORDER BY v.recorded_at DESC`,
      relatedRegistrationIds
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
         SELECT violation_type_id, MAX(created_at) AS latest_reset_at
         FROM summons_appointments
         WHERE violation_type_id IS NOT NULL
           AND deleted_at IS NULL
           AND registration_id IN (${relatedRegistrationPlaceholders})
         GROUP BY violation_type_id
       ) sa_type ON sa_type.violation_type_id = ru.violation_type_id
       LEFT JOIN (
         SELECT MAX(created_at) AS latest_reset_at
         FROM summons_appointments
         WHERE violation_type_id IS NULL
           AND deleted_at IS NULL
           AND registration_id IN (${relatedRegistrationPlaceholders})
       ) sa_global ON 1=1
       WHERE v.registration_id IN (${relatedRegistrationPlaceholders})
         AND v.deleted_at IS NULL
         AND v.recorded_at > COALESCE(
           GREATEST(
             COALESCE(sa_type.latest_reset_at, '1000-01-01'),
             COALESCE(sa_global.latest_reset_at, '1000-01-01')
           ),
           '1000-01-01 00:00:00'
       )
       GROUP BY type_group_id, rule_name, max_violations`,
      [...relatedRegistrationIds, ...relatedRegistrationIds, ...relatedRegistrationIds]
    );

    await ensureSummonsAppointmentsTable(conn);
    const summonsAppointments = await conn.query(
      `SELECT sa.*,
              DATE_FORMAT(sa.scheduled_at, '%Y-%m-%dT%H:%i') AS scheduled_at_input,
              a.full_name AS summoned_by_name
       FROM summons_appointments sa
       JOIN admins a ON sa.summoned_by = a.id
       WHERE sa.registration_id IN (${relatedRegistrationPlaceholders})
         AND sa.deleted_at IS NULL
       ORDER BY sa.created_at DESC`,
      relatedRegistrationIds
    );

    res.render('registrations/detail', {
      title: `${reg.first_name} ${reg.last_name} - BU MotoSpace`,
      reg,
      vehicles,
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
    await ensureVehicleSchema(conn);
    await conn.beginTransaction();
    await conn.query(
      `UPDATE vehicles
       SET status = 'approved', approved_by = ?, approved_at = NOW()
       WHERE deleted_at IS NULL
         AND (
           source_registration_id = ?
           OR (
             owner_registration_id = ?
             AND source_registration_id IS NULL
             AND created_by IS NULL
           )
         )`,
      [req.session.admin.id, req.params.id, req.params.id]
    );
    await syncRegistrationStatusFromPublicVehicles(conn, Number(req.params.id), req.session.admin.id);
    await conn.commit();
    req.flash('success', 'อนุมัติเรียบร้อยแล้ว');
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/registrations/' + req.params.id);
});

// POST /registrations/:id/reject
router.post('/:id/reject', isHead, async (req, res) => {
  const rejectionNote = (req.body.notes || '').trim();

  if (!rejectionNote) {
    req.flash('error', 'กรุณากรอกหมายเหตุก่อนยืนยัน');
    return res.redirect('/registrations/' + req.params.id);
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await ensureVehicleSchema(conn);
    await conn.beginTransaction();
    await conn.query(
      `UPDATE vehicles
       SET status = 'rejected', notes = ?, approved_by = ?, approved_at = NOW()
       WHERE deleted_at IS NULL
         AND (
           source_registration_id = ?
           OR (
             owner_registration_id = ?
             AND source_registration_id IS NULL
             AND created_by IS NULL
         )
       )`,
      [rejectionNote, req.session.admin.id, req.params.id, req.params.id]
    );
    await syncRegistrationStatusFromPublicVehicles(conn, Number(req.params.id), req.session.admin.id, rejectionNote);
    await conn.commit();
    req.flash('success', 'ปฏิเสธเรียบร้อยแล้ว');
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
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
    const [reg] = await conn.query('SELECT * FROM registrations WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
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
  { name: 'id_card_photo', maxCount: 1 },
]), verifyCsrf, async (req, res) => {
  let conn;
  let transactionStarted = false;
  try {
    conn = await pool.getConnection();
    await ensureVehicleSchema(conn);
    await conn.beginTransaction();
    transactionStarted = true;

    const [currentReg] = await conn.query(
      'SELECT id, user_type, id_number FROM registrations WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
      [req.params.id]
    );
    if (!currentReg) {
      await conn.rollback();
      transactionStarted = false;
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'ไม่พบข้อมูลผู้ใช้ที่ต้องการแก้ไข');
      return res.redirect('/registrations');
    }

    const userType = (req.body.user_type || '').trim();
    const idNumber = (req.body.id_number || '').trim();
    const firstName = (req.body.first_name || '').trim();
    const lastName = (req.body.last_name || '').trim();
    const phone = (req.body.phone || '').trim() || null;

    if (!['student', 'staff'].includes(userType) || !idNumber || !firstName || !lastName) {
      await conn.rollback();
      transactionStarted = false;
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'กรุณากรอกข้อมูลส่วนตัวให้ครบถ้วน');
      return res.redirect('/registrations/' + req.params.id + '/edit');
    }

    const relatedRegistrationIds = await getRelatedRegistrationIdsForUser(conn, currentReg);
    const relatedRegistrationPlaceholders = sqlPlaceholders(relatedRegistrationIds);

    let idCardPhoto = null;
    if (req.files && req.files.id_card_photo) {
      idCardPhoto = '/uploads/id-cards/' + req.files.id_card_photo[0].filename;
    } else {
      const [existingIdCard] = await conn.query(
        `SELECT id_card_photo
         FROM registrations
         WHERE id IN (${relatedRegistrationPlaceholders})
           AND id_card_photo IS NOT NULL
           AND TRIM(id_card_photo) <> ''
         ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id ASC
         LIMIT 1`,
        [...relatedRegistrationIds, req.params.id]
      );
      if (existingIdCard && existingIdCard.id_card_photo) {
        idCardPhoto = existingIdCard.id_card_photo;
      }
    }

    const [duplicateOwner] = await conn.query(
      `SELECT id
       FROM registrations
       WHERE user_type = ?
         AND id_number = ?
         AND deleted_at IS NULL
         AND id NOT IN (${relatedRegistrationPlaceholders})
       LIMIT 1`,
      [userType, idNumber, ...relatedRegistrationIds]
    );

    if (duplicateOwner) {
      await conn.rollback();
      transactionStarted = false;
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'รหัสนี้มีผู้ใช้อื่นอยู่ในระบบแล้ว ไม่สามารถเปลี่ยนให้ซ้ำกันได้');
      return res.redirect('/registrations/' + req.params.id + '/edit');
    }

    let sql = `UPDATE registrations SET user_type = ?, id_number = ?, first_name = ?, last_name = ?, phone = ?`;
    const params = [userType, idNumber, firstName, lastName, phone];

    if (idCardPhoto) {
      sql += ', id_card_photo = ?';
      params.push(idCardPhoto);
    }

    sql += ` WHERE id IN (${relatedRegistrationPlaceholders})`;
    params.push(...relatedRegistrationIds);

    await conn.query(sql, params);

    const ownerRegistrationId = await findCanonicalOwnerRegistrationId(conn, userType, idNumber, Number(req.params.id));
    await conn.query(
      `UPDATE vehicles
       SET owner_registration_id = ?
       WHERE owner_registration_id IN (${relatedRegistrationPlaceholders})
          OR source_registration_id IN (${relatedRegistrationPlaceholders})`,
      [ownerRegistrationId, ...relatedRegistrationIds, ...relatedRegistrationIds]
    );

    await conn.commit();
    transactionStarted = false;
    req.flash('success', 'แก้ไขข้อมูลเรียบร้อยแล้ว');
  } catch (err) {
    if (conn && transactionStarted) await conn.rollback();
    console.error(err);
    upload.cleanupUploadedFiles(req);
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
    await ensureVehicleSchema(conn);
    await ensureSummonsAppointmentsTable(conn);

    const [reg] = await conn.query(
      'SELECT id, user_type, id_number FROM registrations WHERE id = ?',
      [registrationId]
    );
    if (!reg) {
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'ไม่พบข้อมูลผู้ใช้ของรายการเรียกพบ');
      return res.redirect(returnTo);
    }
    const relatedRegistrationIds = await getRelatedRegistrationIdsForUser(conn, reg);
    const relatedRegistrationPlaceholders = sqlPlaceholders(relatedRegistrationIds);

    const [appointment] = await conn.query(
      `SELECT sa.id, sa.registration_id, r.first_name, r.last_name
       FROM summons_appointments sa
       JOIN registrations r ON sa.registration_id = r.id
       WHERE sa.id = ? AND sa.registration_id IN (${relatedRegistrationPlaceholders})`,
      [appointmentId, ...relatedRegistrationIds]
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
    params.push(appointmentId, appointment.registration_id);

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
router.post('/:id/delete', isHead, verifyCsrf, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureVehicleSchema(conn);
    await conn.beginTransaction();

    const [reg] = await conn.query('SELECT id, user_type, id_number FROM registrations WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!reg) {
      await conn.rollback();
      req.flash('error', 'ไม่พบข้อมูลทะเบียน หรือข้อมูลถูกลบชั่วคราวแล้ว');
      return res.redirect('/registrations');
    }
    const relatedRegistrationIds = await getRelatedRegistrationIdsForUser(conn, reg);
    const relatedRegistrationPlaceholders = sqlPlaceholders(relatedRegistrationIds);

    const reason = (req.body.delete_reason || '').trim();
    if (!reason) {
      await conn.rollback();
      req.flash('error', 'กรุณากรอกหมายเหตุในการลบข้อมูลทะเบียนรถ');
      return res.redirect('/registrations/' + req.params.id);
    }
    await conn.query(
      `UPDATE violation_reports
       SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?
       WHERE registration_id IN (${relatedRegistrationPlaceholders}) AND deleted_at IS NULL`,
      [req.session.admin.id, reason, ...relatedRegistrationIds]
    );
    await conn.query(
      `UPDATE summons_appointments
       SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?
       WHERE registration_id IN (${relatedRegistrationPlaceholders}) AND deleted_at IS NULL`,
      [req.session.admin.id, reason, ...relatedRegistrationIds]
    );
    await conn.query(
      `UPDATE violations
       SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?
       WHERE registration_id IN (${relatedRegistrationPlaceholders}) AND deleted_at IS NULL`,
      [req.session.admin.id, reason, ...relatedRegistrationIds]
    );
    await conn.query(
      `UPDATE registrations
       SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?
       WHERE id IN (${relatedRegistrationPlaceholders}) AND deleted_at IS NULL`,
      [req.session.admin.id, reason, ...relatedRegistrationIds]
    );
    await conn.query(
      `UPDATE vehicles
       SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?
       WHERE (owner_registration_id IN (${relatedRegistrationPlaceholders})
              OR source_registration_id IN (${relatedRegistrationPlaceholders}))
         AND deleted_at IS NULL`,
      [req.session.admin.id, reason, ...relatedRegistrationIds, ...relatedRegistrationIds]
    );

    await conn.commit();
    req.flash('success', 'ลบข้อมูลชั่วคราวเรียบร้อยแล้ว สามารถกู้คืนได้จากหน้าจัดการทะเบียนรถ');
  } catch (err) {
    if (conn) await conn.rollback();
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/registrations');
});

// POST /registrations/:id/restore
router.post('/:id/restore', isHead, verifyCsrf, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureVehicleSchema(conn);
    await conn.beginTransaction();

    const [reg] = await conn.query('SELECT id, user_type, id_number FROM registrations WHERE id = ? AND deleted_at IS NOT NULL', [req.params.id]);
    if (!reg) {
      await conn.rollback();
      req.flash('error', 'ไม่พบข้อมูลที่ถูกลบชั่วคราว');
      return res.redirect('/registrations?status=deleted');
    }
    const relatedRegistrationIds = await getRelatedRegistrationIdsForUser(conn, reg);
    const relatedRegistrationPlaceholders = sqlPlaceholders(relatedRegistrationIds);

    await conn.query(
      `UPDATE registrations
       SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
       WHERE id IN (${relatedRegistrationPlaceholders})`,
      relatedRegistrationIds
    );
    await conn.query(
      `UPDATE violations
       SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
       WHERE registration_id IN (${relatedRegistrationPlaceholders})`,
      relatedRegistrationIds
    );
    await conn.query(
      `UPDATE violation_reports
       SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
       WHERE registration_id IN (${relatedRegistrationPlaceholders})`,
      relatedRegistrationIds
    );
    await conn.query(
      `UPDATE summons_appointments
       SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
       WHERE registration_id IN (${relatedRegistrationPlaceholders})`,
      relatedRegistrationIds
    );
    await conn.query(
      `UPDATE vehicles
       SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
       WHERE owner_registration_id IN (${relatedRegistrationPlaceholders})
          OR source_registration_id IN (${relatedRegistrationPlaceholders})`,
      [...relatedRegistrationIds, ...relatedRegistrationIds]
    );

    await conn.commit();
    req.flash('success', 'กู้คืนข้อมูลทะเบียนรถเรียบร้อยแล้ว');
  } catch (err) {
    if (conn) await conn.rollback();
    console.error(err);
    req.flash('error', 'ไม่สามารถกู้คืนข้อมูลได้');
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/registrations?status=deleted');
});

module.exports = router;
