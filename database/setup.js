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
      port: parseInt(process.env.DB_PORT) || 3036,
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
      CREATE TABLE IF NOT EXISTS rules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        rule_name VARCHAR(200) NOT NULL,
        description TEXT,
        max_violations INT NOT NULL DEFAULT 3,
        penalty TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_by INT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
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
      ) ENGINE=InnoDB
    `);
    console.log('  ✅ violations');

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
      const hashedPw = await bcrypt.hash('admin123', 10);
      await conn.query(
        'INSERT INTO admins (username, password, full_name, role) VALUES (?, ?, ?, ?)',
        ['admin', hashedPw, 'ผู้ดูแลระบบ', 'superadmin']
      );
      console.log('✅ Created default superadmin: admin / admin123');
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
