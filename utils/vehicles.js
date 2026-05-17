function normalizePlate(plate) {
  return (plate || '').trim().replace(/\s+/g, '').toUpperCase();
}

function normalizeCompact(value) {
  return (value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function normalizeDisplayText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function sqlNormalizeCompactExpression(columnName) {
  return `UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(${columnName}), ' ', ''), CHAR(9), ''), CHAR(10), ''), CHAR(13), ''), CHAR(160), ''))`;
}

function sqlNormalizePlateExpression(columnName) {
  return sqlNormalizeCompactExpression(columnName);
}

function createDuplicatePlateError(record) {
  const error = new Error('duplicate_plate');
  error.code = 'DUPLICATE_PLATE';
  error.duplicate = {
    source: record.source || null,
    registrationId: record.registration_id || record.owner_registration_id || null,
    vehicleId: record.vehicle_id || null,
    ownerName: [record.first_name, record.last_name].filter(Boolean).join(' ').trim(),
    idNumber: record.id_number || null,
    userType: record.user_type || null,
    licensePlate: record.license_plate || null,
    province: record.province || null,
  };
  return error;
}

async function findCanonicalOwnerRegistrationId(conn, userType, idNumber, fallbackRegistrationId = null) {
  const cleanUserType = (userType || '').trim();
  const normalizedIdNumber = normalizeCompact(idNumber);
  if (!cleanUserType || !normalizedIdNumber) return fallbackRegistrationId;

  const [owner] = await conn.query(
    `SELECT id
     FROM registrations
     WHERE user_type = ?
       AND ${sqlNormalizeCompactExpression('id_number')} = ?
       AND deleted_at IS NULL
     ORDER BY id ASC
     LIMIT 1`,
    [cleanUserType, normalizedIdNumber]
  );

  return owner ? Number(owner.id) : fallbackRegistrationId;
}

async function assertOwnerIdentityAvailable(conn, userType, idNumber, firstName, lastName) {
  const cleanUserType = (userType || '').trim();
  const normalizedIdNumber = normalizeCompact(idNumber);
  const normalizedFirstName = normalizeCompact(firstName);
  const normalizedLastName = normalizeCompact(lastName);

  if (!cleanUserType || !normalizedIdNumber || !normalizedFirstName || !normalizedLastName) {
    const error = new Error('owner_identity_required');
    error.code = 'VALIDATION_ERROR';
    throw error;
  }

  const [existingOwner] = await conn.query(
    `SELECT id, first_name, last_name
     FROM registrations
     WHERE user_type = ?
       AND ${sqlNormalizeCompactExpression('id_number')} = ?
       AND deleted_at IS NULL
     ORDER BY id ASC
     LIMIT 1`,
    [cleanUserType, normalizedIdNumber]
  );

  if (!existingOwner) return true;

  const existingFirstName = normalizeCompact(existingOwner.first_name);
  const existingLastName = normalizeCompact(existingOwner.last_name);
  if (existingFirstName === normalizedFirstName && existingLastName === normalizedLastName) {
    return true;
  }

  const error = new Error('owner_identity_mismatch');
  error.code = 'OWNER_IDENTITY_MISMATCH';
  throw error;
}

async function ensureVehicleSchema(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      owner_registration_id INT NOT NULL,
      source_registration_id INT DEFAULT NULL,
      license_plate VARCHAR(20) NOT NULL,
      normalized_plate VARCHAR(50) NOT NULL,
      province VARCHAR(100) NOT NULL,
      motorcycle_photo VARCHAR(500) DEFAULT NULL,
      plate_photo VARCHAR(500) DEFAULT NULL,
      status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
      notes TEXT DEFAULT NULL,
      created_by INT DEFAULT NULL,
      approved_by INT DEFAULT NULL,
      approved_at TIMESTAMP NULL DEFAULT NULL,
      deleted_at TIMESTAMP NULL DEFAULT NULL,
      deleted_by INT DEFAULT NULL,
      delete_reason TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_vehicles_normalized_plate (normalized_plate),
      INDEX idx_vehicles_owner (owner_registration_id),
      INDEX idx_vehicles_status (status),
      INDEX idx_vehicles_deleted_at (deleted_at),
      FOREIGN KEY (owner_registration_id) REFERENCES registrations(id) ON DELETE CASCADE,
      FOREIGN KEY (source_registration_id) REFERENCES registrations(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE SET NULL,
      FOREIGN KEY (approved_by) REFERENCES admins(id) ON DELETE SET NULL,
      FOREIGN KEY (deleted_by) REFERENCES admins(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
}

async function backfillVehiclesFromRegistrations(conn) {
  await ensureVehicleSchema(conn);
  await conn.query(`
    INSERT IGNORE INTO vehicles (
      owner_registration_id,
      source_registration_id,
      license_plate,
      normalized_plate,
      province,
      motorcycle_photo,
      plate_photo,
      status,
      notes,
      approved_by,
      approved_at,
      deleted_at,
      deleted_by,
      delete_reason,
      created_at
    )
    SELECT
      r.id,
      r.id,
      r.license_plate,
      UPPER(REPLACE(TRIM(r.license_plate), ' ', '')),
      r.province,
      r.motorcycle_photo,
      r.plate_photo,
      r.status,
      r.notes,
      r.approved_by,
      r.approved_at,
      r.deleted_at,
      r.deleted_by,
      r.delete_reason,
      r.registered_at
    FROM registrations r
    WHERE r.license_plate IS NOT NULL
      AND TRIM(r.license_plate) <> ''
  `);

  await conn.query(`
    UPDATE vehicles v
    JOIN registrations source_reg ON source_reg.id = v.source_registration_id
    JOIN (
      SELECT user_type, id_number, MIN(id) AS owner_id
      FROM registrations
      WHERE deleted_at IS NULL
      GROUP BY user_type, id_number
    ) owners
      ON owners.user_type = source_reg.user_type
     AND owners.id_number = source_reg.id_number
    SET v.owner_registration_id = owners.owner_id
    WHERE v.source_registration_id IS NOT NULL
      AND v.deleted_at IS NULL
  `);
}

async function assertPlateAvailable(conn, licensePlate, excludeVehicleId = null) {
  const normalizedPlate = normalizePlate(licensePlate);
  if (!normalizedPlate) {
    const error = new Error('license_plate_required');
    error.code = 'VALIDATION_ERROR';
    throw error;
  }

  const vehiclePlateExpression = sqlNormalizePlateExpression('v.license_plate');
  const registrationPlateExpression = sqlNormalizePlateExpression('license_plate');
  const vehicleParams = [normalizedPlate, normalizedPlate];
  let vehicleWhere = '(v.normalized_plate = ? OR ' + vehiclePlateExpression + ' = ?)';
  if (excludeVehicleId) {
    vehicleWhere += ' AND v.id <> ?';
    vehicleParams.push(excludeVehicleId);
  }

  const [existingVehicle] = await conn.query(
    `SELECT
       v.id AS vehicle_id,
       v.owner_registration_id,
       v.source_registration_id,
       v.license_plate,
       v.province,
       COALESCE(owner_reg.id, source_reg.id) AS registration_id,
       COALESCE(owner_reg.user_type, source_reg.user_type) AS user_type,
       COALESCE(owner_reg.id_number, source_reg.id_number) AS id_number,
       COALESCE(owner_reg.first_name, source_reg.first_name) AS first_name,
       COALESCE(owner_reg.last_name, source_reg.last_name) AS last_name,
       'vehicles' AS source
     FROM vehicles v
     LEFT JOIN registrations owner_reg ON v.owner_registration_id = owner_reg.id
     LEFT JOIN registrations source_reg ON v.source_registration_id = source_reg.id
     WHERE ${vehicleWhere}
     LIMIT 1`,
    vehicleParams
  );
  if (existingVehicle) {
    throw createDuplicatePlateError(existingVehicle);
  }

  const registrationParams = [normalizedPlate];
  let registrationWhere = `${registrationPlateExpression} = ?`;
  if (excludeVehicleId) {
    registrationWhere += ` AND id NOT IN (
      SELECT source_registration_id
      FROM vehicles
      WHERE id = ? AND source_registration_id IS NOT NULL
    )`;
    registrationParams.push(excludeVehicleId);
  }

  const [existingRegistration] = await conn.query(
    `SELECT
       id AS registration_id,
       user_type,
       id_number,
       first_name,
       last_name,
       license_plate,
       province,
       'registrations' AS source
     FROM registrations
     WHERE ${registrationWhere}
     LIMIT 1`,
    registrationParams
  );
  if (existingRegistration) {
    throw createDuplicatePlateError(existingRegistration);
  }

  return normalizedPlate;
}

module.exports = {
  normalizePlate,
  normalizeCompact,
  normalizeDisplayText,
  findCanonicalOwnerRegistrationId,
  assertOwnerIdentityAvailable,
  ensureVehicleSchema,
  backfillVehiclesFromRegistrations,
  assertPlateAvailable,
};
