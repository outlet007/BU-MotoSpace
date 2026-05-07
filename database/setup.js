/**
 * Database Setup Script
 * Run this once to create tables and seed data.
 * Usage: node database/setup.js
 */
const mariadb = require('mariadb');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function setup() {
  let conn;
  try {
    console.log('🔧 Connecting to MariaDB...');
    conn = await mariadb.createConnection({
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'asset_user',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'bu_motospace',
      connectTimeout: 10000,
      multipleStatements: false,
    });
    console.log('✅ Connected to MariaDB');

    // Create tables one by one
    console.log('🔧 Creating tables...');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS departments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        department_name VARCHAR(200) NOT NULL UNIQUE,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    console.log('  ✅ departments');

    await conn.query(`
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
      ) ENGINE=InnoDB
    `);
    console.log('  ✅ admins');

    await conn.query(`
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
      ) ENGINE=InnoDB
    `);
    console.log('  ✅ registrations');

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
    console.log('  OK violation_types');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS penalty_types (
        id INT AUTO_INCREMENT PRIMARY KEY,
        penalty_name VARCHAR(200) NOT NULL UNIQUE,
        description TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_by INT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE SET NULL
      ) ENGINE=InnoDB
    `);
    console.log('  OK penalty_types');

    await conn.query(`
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
      ) ENGINE=InnoDB
    `);
    console.log('  ✅ rules');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key VARCHAR(100) PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_by INT DEFAULT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (updated_by) REFERENCES admins(id) ON DELETE SET NULL
      ) ENGINE=InnoDB
    `);
    console.log('  ✅ app_settings');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS app_sessions (
        sid VARCHAR(128) PRIMARY KEY,
        sess LONGTEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_app_sessions_expires_at (expires_at)
      ) ENGINE=InnoDB
    `);
    console.log('  OK app_sessions');

    await conn.query(`
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
        INDEX idx_rule (rule_id),
        INDEX idx_violations_registration_rule_recorded (registration_id, rule_id, recorded_at)
      ) ENGINE=InnoDB
    `);
    console.log('  ✅ violations');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS summons_appointments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        appointment_code VARCHAR(30) DEFAULT NULL,
        registration_id INT NOT NULL,
        scheduled_at DATETIME NOT NULL,
        note TEXT,
        written_document VARCHAR(500) DEFAULT NULL,
        written_document_original_name VARCHAR(255) DEFAULT NULL,
        violation_type_id INT DEFAULT NULL,
        summoned_by INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (registration_id) REFERENCES registrations(id) ON DELETE CASCADE,
        FOREIGN KEY (violation_type_id) REFERENCES violation_types(id) ON DELETE SET NULL,
        FOREIGN KEY (summoned_by) REFERENCES admins(id) ON DELETE CASCADE,
        UNIQUE KEY uq_summons_appointment_code (appointment_code),
        INDEX idx_registration_created (registration_id, created_at),
        INDEX idx_summons_violation_type (violation_type_id),
        INDEX idx_scheduled_at (scheduled_at)
      ) ENGINE=InnoDB
    `);
    console.log('  OK summons_appointments');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS violation_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        registration_id INT NOT NULL,
        rule_id INT NOT NULL,
        description TEXT,
        evidence_photo VARCHAR(500),
        reported_by INT NOT NULL,
        reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status ENUM('pending','confirmed','rejected') NOT NULL DEFAULT 'pending',
        reviewed_by INT DEFAULT NULL,
        reviewed_at TIMESTAMP NULL,
        review_note TEXT,
        violation_id INT DEFAULT NULL,
        FOREIGN KEY (registration_id) REFERENCES registrations(id) ON DELETE CASCADE,
        FOREIGN KEY (rule_id) REFERENCES rules(id) ON DELETE CASCADE,
        FOREIGN KEY (reported_by) REFERENCES admins(id) ON DELETE CASCADE,
        FOREIGN KEY (reviewed_by) REFERENCES admins(id) ON DELETE SET NULL,
        FOREIGN KEY (violation_id) REFERENCES violations(id) ON DELETE SET NULL,
        INDEX idx_vr_registration (registration_id),
        INDEX idx_vr_status (status)
      ) ENGINE=InnoDB
    `);
    console.log('  OK violation_reports');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS image_hashes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        registration_id INT NOT NULL,
        image_type ENUM('motorcycle','plate') NOT NULL,
        phash VARCHAR(64) NOT NULL,
        file_path VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (registration_id) REFERENCES registrations(id) ON DELETE CASCADE,
        INDEX idx_phash (phash)
      ) ENGINE=InnoDB
    `);
    console.log('  ✅ image_hashes');

    // Seed admin
    const adminRows = await conn.query('SELECT COUNT(*) as cnt FROM admins');
    if (parseInt(adminRows[0].cnt) === 0) {
      const defaultAdminUsername = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
      const defaultAdminPassword = process.env.DEFAULT_ADMIN_PASSWORD || (process.env.NODE_ENV === 'production' ? '' : 'admin123');
      if (!defaultAdminPassword || (process.env.NODE_ENV === 'production' && defaultAdminPassword.length < 12)) {
        throw new Error('DEFAULT_ADMIN_PASSWORD must be set to at least 12 characters before creating the first production admin');
      }
      const hashedPw = await bcrypt.hash(defaultAdminPassword, 10);
      await conn.query(
        'INSERT INTO admins (username, password, full_name, role) VALUES (?, ?, ?, ?)',
        [defaultAdminUsername, hashedPw, 'ผู้ดูแลระบบ', 'superadmin']
      );
      console.log(`Created default superadmin account: ${defaultAdminUsername}`);
    } else {
      console.log('✅ Admin accounts already exist (' + adminRows[0].cnt + ')');
    }

    // Seed rules
    const ruleRows = await conn.query('SELECT COUNT(*) as cnt FROM rules');
    if (parseInt(ruleRows[0].cnt) === 0) {
      await conn.query(
        "INSERT INTO rules (rule_name, description, max_violations, penalty, is_active) VALUES (?, ?, ?, ?, ?)",
        ['จอดรถในที่ห้ามจอด', 'จอดรถจักรยานยนต์ในพื้นที่ที่ไม่อนุญาต', 3, 'ตักเตือน / ระงับสิทธิ์การใช้ที่จอดรถ', true]
      );
      await conn.query(
        "INSERT INTO rules (rule_name, description, max_violations, penalty, is_active) VALUES (?, ?, ?, ?, ?)",
        ['ขับรถเร็วเกินกำหนด', 'ขับขี่ด้วยความเร็วเกินกว่าที่กำหนดภายในมหาวิทยาลัย', 2, 'ตักเตือน / ระงับสิทธิ์การนำรถเข้า', true]
      );
      await conn.query(
        "INSERT INTO rules (rule_name, description, max_violations, penalty, is_active) VALUES (?, ?, ?, ?, ?)",
        ['ไม่สวมหมวกกันน็อค', 'ขับขี่โดยไม่สวมหมวกกันน็อคภายในเขตมหาวิทยาลัย', 3, 'ตักเตือน / ปรับ', true]
      );
      await conn.query(
        "INSERT INTO rules (rule_name, description, max_violations, penalty, is_active) VALUES (?, ?, ?, ?, ?)",
        ['ไม่ติดสติ๊กเกอร์ลงทะเบียน', 'นำรถเข้ามหาวิทยาลัยโดยไม่มีสติ๊กเกอร์ลงทะเบียน', 1, 'ระงับสิทธิ์ทันที', true]
      );
      await conn.query(
        "INSERT INTO rules (rule_name, description, max_violations, penalty, is_active) VALUES (?, ?, ?, ?, ?)",
        ['แต่งรถผิดกฎหมาย', 'นำรถที่ดัดแปลงผิดกฎหมายเข้ามหาวิทยาลัย เช่น ท่อดัง', 2, 'ตักเตือน / ห้ามนำรถเข้า', true]
      );
      console.log('✅ Seeded 5 default rules');
    } else {
      console.log('✅ Rules already exist (' + ruleRows[0].cnt + ')');
    }

    console.log('\n🏍️  Setup complete! Run "npm run dev" to start.');
    conn.end();
    process.exit(0);

  } catch (err) {
    console.error('❌ Setup failed:', err.message);
    if (conn) conn.end();
    process.exit(1);
  }
}

setup();
