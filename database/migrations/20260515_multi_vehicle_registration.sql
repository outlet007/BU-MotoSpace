-- Refactor registrations to support one user owning multiple vehicles.
-- Backward compatible: the existing registrations table remains in place.
-- Existing rows are copied into vehicles as one vehicle per legacy registration.

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
) ENGINE=InnoDB;

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
  owners.owner_id,
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
JOIN (
  SELECT user_type, id_number, MIN(id) AS owner_id
  FROM registrations
  WHERE deleted_at IS NULL
  GROUP BY user_type, id_number
) owners
  ON owners.user_type = r.user_type
 AND owners.id_number = r.id_number
WHERE r.license_plate IS NOT NULL
  AND TRIM(r.license_plate) <> '';

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
  AND v.deleted_at IS NULL;
