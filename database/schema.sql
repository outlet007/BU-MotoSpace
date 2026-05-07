-- BU MotoSpace Database Schema
CREATE DATABASE IF NOT EXISTS bu_motospace CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE bu_motospace;

-- ตารางหน่วยงาน
CREATE TABLE IF NOT EXISTS departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  department_name VARCHAR(200) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ตาราง admins (เจ้าหน้าที่, หัวหน้า, ผู้ดูแลระบบ)
CREATE TABLE IF NOT EXISTS admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  full_name VARCHAR(200) NOT NULL,
  email VARCHAR(200) DEFAULT NULL,
  phone VARCHAR(20) DEFAULT NULL,
  department_id INT DEFAULT NULL,
  role ENUM('officer','head','superadmin') NOT NULL DEFAULT 'officer',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_department (department_id),
  FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ตารางลงทะเบียนรถจักรยานยนต์
CREATE TABLE IF NOT EXISTS registrations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_type ENUM('student','staff') NOT NULL,
  id_number VARCHAR(50) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  phone VARCHAR(20),
  license_plate VARCHAR(20) NOT NULL,
  province VARCHAR(100) NOT NULL,
  motorcycle_photo VARCHAR(500),
  plate_photo VARCHAR(500),
  id_card_photo VARCHAR(500),
  status ENUM('pending','approved','rejected') DEFAULT 'pending',
  registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  approved_by INT DEFAULT NULL,
  approved_at TIMESTAMP NULL,
  notes TEXT,
  UNIQUE KEY uq_plate (license_plate),
  INDEX idx_id_number (id_number),
  INDEX idx_user_type (user_type),
  INDEX idx_status (status),
  FOREIGN KEY (approved_by) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ตารางกฎ/ข้อบังคับ
-- Violation types
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
) ENGINE=InnoDB;

-- Penalty types
CREATE TABLE IF NOT EXISTS penalty_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  penalty_name VARCHAR(200) NOT NULL UNIQUE,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Rules and regulations
CREATE TABLE IF NOT EXISTS rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rule_name VARCHAR(200) NOT NULL,
  description TEXT,
  violation_type_id INT DEFAULT NULL,
  penalty_type_id INT DEFAULT NULL,
  max_violations INT NOT NULL DEFAULT 3,
  penalty TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_rules_violation_type (violation_type_id),
  INDEX idx_rules_penalty_type (penalty_type_id),
  FOREIGN KEY (violation_type_id) REFERENCES violation_types(id) ON DELETE SET NULL,
  FOREIGN KEY (penalty_type_id) REFERENCES penalty_types(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ตารางบันทึกการกระทำผิด
-- System settings
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_by INT DEFAULT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (updated_by) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS violations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  registration_id INT NOT NULL,
  rule_id INT NOT NULL,
  description TEXT,
  evidence_photo VARCHAR(500),
  recorded_by INT NOT NULL,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (registration_id) REFERENCES registrations(id) ON DELETE CASCADE,
  FOREIGN KEY (rule_id) REFERENCES rules(id) ON DELETE CASCADE,
  FOREIGN KEY (recorded_by) REFERENCES admins(id) ON DELETE CASCADE,
  INDEX idx_registration (registration_id),
  INDEX idx_rule (rule_id)
) ENGINE=InnoDB;

-- ตารางบันทึกการนัดเรียกพบ
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
) ENGINE=InnoDB;

-- ตาราง image fingerprints สำหรับค้นหาด้วยภาพ
CREATE TABLE IF NOT EXISTS image_hashes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  registration_id INT NOT NULL,
  image_type ENUM('motorcycle','plate') NOT NULL,
  phash VARCHAR(64) NOT NULL,
  file_path VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (registration_id) REFERENCES registrations(id) ON DELETE CASCADE,
  INDEX idx_phash (phash)
) ENGINE=InnoDB;
