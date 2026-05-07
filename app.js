const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const { csrfMiddleware, generateCsrfToken } = require('./middleware/csrf');
const { idleSessionTimeout } = require('./middleware/auth');
require('dotenv').config();

// ตั้งค่า Timezone ของระบบเป็นประเทศไทย (UTC+7)
process.env.TZ = 'Asia/Bangkok';
const pool = require('./config/database');
const { generateSignedUrl, verifySignedUrl, resolveFilePath } = require('./utils/signedUrl');

const app = express();
const PORT = process.env.APP_PORT || 3000;
const DEFAULT_SUMMONS_THRESHOLD = 3;

// Ensure upload directories exist (OUTSIDE public/ for PDPA security)
const uploadDirs = [
  'uploads/motorcycles',
  'uploads/plates',
  'uploads/id-cards',
  'uploads/evidence',
  'uploads/summons-documents',
  'uploads/temp',
  'uploads/misc',
];
uploadDirs.forEach(dir => {
  const fullPath = path.join(__dirname, dir);
  if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
});

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ─── Security Headers (Helmet) ───────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",          // required for inline scripts in EJS
        "https://unpkg.com",         // lucide icons
        "https://www.google.com",    // reCAPTCHA
        "https://www.gstatic.com",   // reCAPTCHA
      ],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'"],
      frameSrc: ["https://www.google.com"], // reCAPTCHA iframe
    },
  },
  crossOriginEmbedderPolicy: false, // allow reCAPTCHA
}));

// Middlewares
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,               // ป้องกัน JS อ่าน cookie
    sameSite: 'lax',              // ป้องกัน CSRF ขั้นพื้นฐาน
    secure: process.env.NODE_ENV === 'production', // HTTPS only ใน prod
  },
}));
app.use(flash());

// ─── CSRF Protection (Session-based Synchronizer Token) ────────────────────────
// ใช้ csrf middleware ที่เขียนเอง โดยใช้ Node.js crypto (built-in) ไม่ต้องติดตั้ง package เพิ่ม
app.use(csrfMiddleware);

// ─── Idle Session Timeout (1 ชั่วโมง) ───────────────────────────────────
// ตรวจสอบทุก request ว่าเวลาของ session ได้หมดอายุเนื่องจากไม่มีการใช้งานหรือยัง
app.use(idleSessionTimeout);

// Global template variables
app.use(async (req, res, next) => {
  res.locals.admin = req.session.admin || null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.currentPath = req.path;
  res.locals.currentUrl = req.originalUrl;

  // CSRF token สำหรับทุก form ใน EJS templates
  res.locals.csrfToken = generateCsrfToken(req);

  // Signed URL helper — available in ALL EJS templates as signedUrl(path)
  // Each call generates a fresh URL valid for 15 minutes
  res.locals.signedUrl = (filePath) => filePath ? generateSignedUrl(filePath) : '';
  
  try {
    const rows = await pool.query("SELECT COUNT(*) as count FROM registrations WHERE status = 'pending'");
    res.locals.pendingCount = Number(rows[0].count);
  } catch(e) {
    console.error('Error fetching pendingCount:', e);
    res.locals.pendingCount = 0;
  }

  try {
    const vrRows = await pool.query("SELECT COUNT(*) as count FROM violation_reports WHERE status = 'pending'");
    res.locals.pendingReportsCount = Number(vrRows[0].count);
  } catch(e) {
    // Table may not exist yet on first boot — silently ignore
    res.locals.pendingReportsCount = 0;
  }

  try {
    await pool.query(`
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
    const summonsAppointmentCodeRows = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'summons_appointments'
         AND COLUMN_NAME = 'appointment_code'`
    );
    if (parseInt(summonsAppointmentCodeRows[0] && summonsAppointmentCodeRows[0].cnt, 10) === 0) {
      await pool.query('ALTER TABLE summons_appointments ADD COLUMN appointment_code VARCHAR(30) DEFAULT NULL AFTER id');
    }
    const summonsAppointmentCodeIndexRows = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'summons_appointments'
         AND INDEX_NAME = 'uq_summons_appointment_code'`
    );
    if (parseInt(summonsAppointmentCodeIndexRows[0] && summonsAppointmentCodeIndexRows[0].cnt, 10) === 0) {
      await pool.query('ALTER TABLE summons_appointments ADD UNIQUE INDEX uq_summons_appointment_code (appointment_code)');
    }

    await pool.query(`
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
    const violationTypeCodeRows = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'violation_types'
         AND COLUMN_NAME = 'type_code'`
    );
    if (parseInt(violationTypeCodeRows[0] && violationTypeCodeRows[0].cnt, 10) === 0) {
      await pool.query('ALTER TABLE violation_types ADD COLUMN type_code VARCHAR(20) DEFAULT NULL AFTER type_name');
    }
    const violationTypeCodeIndexRows = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'violation_types'
         AND INDEX_NAME = 'uq_violation_type_code'`
    );
    if (parseInt(violationTypeCodeIndexRows[0] && violationTypeCodeIndexRows[0].cnt, 10) === 0) {
      await pool.query('ALTER TABLE violation_types ADD UNIQUE INDEX uq_violation_type_code (type_code)');
    }
    const ruleTypeColumnRows = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'rules'
         AND COLUMN_NAME = 'violation_type_id'`
    );
    if (parseInt(ruleTypeColumnRows[0] && ruleTypeColumnRows[0].cnt, 10) === 0) {
      await pool.query('ALTER TABLE rules ADD COLUMN violation_type_id INT DEFAULT NULL AFTER description');
    }
    const violationTypeCountRows = await pool.query('SELECT COUNT(*) AS cnt FROM violation_types');
    if (parseInt(violationTypeCountRows[0] && violationTypeCountRows[0].cnt, 10) === 0) {
      const maxRows = await pool.query(
        'SELECT DISTINCT max_violations FROM rules WHERE max_violations IS NOT NULL ORDER BY max_violations ASC'
      );
      const seedRows = maxRows.length > 0 ? maxRows : [{ max_violations: DEFAULT_SUMMONS_THRESHOLD }];

      for (const row of seedRows) {
        const maxViolations = Math.max(parseInt(row.max_violations, 10) || DEFAULT_SUMMONS_THRESHOLD, 1);
        await pool.query(
          `INSERT INTO violation_types (type_name, max_violations, is_active)
           VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE max_violations = VALUES(max_violations)`,
          [`ประเภทความผิด ${maxViolations} ครั้ง`, maxViolations]
        );
      }
    }
    const usedTypeCodeRows = await pool.query(
      `SELECT UPPER(type_code) AS type_code
       FROM violation_types
       WHERE type_code IS NOT NULL AND TRIM(type_code) <> ''`
    );
    const usedTypeCodes = new Set(usedTypeCodeRows.map(row => row.type_code));
    const missingTypeCodeRows = await pool.query(
      `SELECT id, type_name
       FROM violation_types
       WHERE type_code IS NULL OR TRIM(type_code) = ''`
    );
    for (const row of missingTypeCodeRows) {
      const name = String(row.type_name || '').toLowerCase();
      let suggestedCode = null;
      if (name.includes('เล็กน้อย') || name.includes('minor') || name.includes('min')) suggestedCode = 'MIN';
      if (name.includes('ปานกลาง') || name.includes('major') || name.includes('maj')) suggestedCode = 'MAJ';
      if (name.includes('ร้ายแรง') || name.includes('critical') || name.includes('cri')) suggestedCode = 'CRI';
      if (suggestedCode && !usedTypeCodes.has(suggestedCode)) {
        await pool.query('UPDATE violation_types SET type_code = ? WHERE id = ?', [suggestedCode, row.id]);
        usedTypeCodes.add(suggestedCode);
      }
    }
    const unassignedRuleRows = await pool.query(
      'SELECT COUNT(*) AS cnt FROM rules WHERE violation_type_id IS NULL'
    );
    if (parseInt(unassignedRuleRows[0] && unassignedRuleRows[0].cnt, 10) > 0) {
      const typeRows = await pool.query(
        'SELECT id, max_violations FROM violation_types ORDER BY is_active DESC, id ASC'
      );

      for (const type of typeRows) {
        await pool.query(
          `UPDATE rules
           SET violation_type_id = ?
           WHERE violation_type_id IS NULL AND max_violations = ?`,
          [type.id, type.max_violations]
        );
      }

      if (typeRows.length > 0) {
        await pool.query(
          `UPDATE rules
           SET violation_type_id = ?
           WHERE violation_type_id IS NULL`,
          [typeRows[0].id]
        );
      }
    }

    const summonsRows = await pool.query(
      `SELECT COUNT(*) as count
       FROM (
         SELECT registration_id
         FROM (
           SELECT
             r.id AS registration_id,
             COALESCE(ru.violation_type_id, -ru.id) AS violation_group_id,
             COUNT(v.id) AS type_violations,
             COALESCE(MAX(vt.max_violations), MAX(ru.max_violations), ${DEFAULT_SUMMONS_THRESHOLD}) AS required_violations
           FROM registrations r
           LEFT JOIN (
             SELECT registration_id, MAX(created_at) AS latest_reset_at
             FROM summons_appointments
             GROUP BY registration_id
           ) sa ON sa.registration_id = r.id
           JOIN violations v
             ON v.registration_id = r.id
            AND v.recorded_at > COALESCE(sa.latest_reset_at, '1000-01-01 00:00:00')
           JOIN rules ru ON v.rule_id = ru.id
           LEFT JOIN violation_types vt ON ru.violation_type_id = vt.id
           GROUP BY r.id, COALESCE(ru.violation_type_id, -ru.id)
           HAVING type_violations >= required_violations
         ) qualified_by_type
         GROUP BY registration_id
       ) candidates`,
    );
    res.locals.summonsCandidatesCount = Number(summonsRows[0].count);
  } catch(e) {
    res.locals.summonsCandidatesCount = 0;
  }

  next();
});

// ─── Signed Image Endpoint (PDPA-compliant) ─────────────────────────────────
// ALL protected images are served via signed, time-limited tokens.
// URL format: /img/<base64url-path>?exp=<ts>&sig=<hmac>
// - Requires valid admin session AND a valid, unexpired HMAC token
// - Even if a URL leaks, it is useless after 15 minutes
// - Blocks indexing, caching, iframe embedding, MIME sniffing, and referrer leaks
// ─────────────────────────────────────────────────────────────────────────────
app.get('/img/:encoded', (req, res) => {
  // 1. Auth check — must be logged-in admin
  if (!req.session || !req.session.admin) {
    return res.status(403).send(`
      <!DOCTYPE html><html lang="th"><head><meta charset="UTF-8">
      <title>ไม่มีสิทธิ์เข้าถึง</title></head>
      <body style="font-family:'Noto Sans Thai',sans-serif;text-align:center;margin-top:80px;">
        <h2>🔒 403 — ไม่มีสิทธิ์เข้าถึง</h2>
        <p>คุณต้องเข้าสู่ระบบก่อนถึงจะดูไฟล์นี้ได้</p>
        <a href="/auth/login">เข้าสู่ระบบ</a>
      </body></html>`);
  }

  // 2. Token verification — HMAC + expiry
  const { encoded } = req.params;
  const { exp, sig } = req.query;
  const filePath = verifySignedUrl(encoded, exp, sig);

  if (!filePath) {
    return res.status(403).send(`
      <!DOCTYPE html><html lang="th"><head><meta charset="UTF-8">
      <title>ลิงก์หมดอายุ</title></head>
      <body style="font-family:'Noto Sans Thai',sans-serif;text-align:center;margin-top:80px;">
        <h2>⏰ 403 — ลิงก์หมดอายุหรือไม่ถูกต้อง</h2>
        <p>ลิงก์รูปภาพนี้หมดอายุแล้ว (15 นาที) กรุณาโหลดหน้าใหม่เพื่อรับลิงก์ใหม่</p>
        <button onclick="history.back()">← กลับ</button>
      </body></html>`);
  }

  // 3. Resolve to absolute disk path and serve
  const absPath = resolveFilePath(filePath, __dirname);

  // Safety check: path must stay within uploads directory
  const uploadsDir = path.join(__dirname, 'uploads');
  if (!absPath.startsWith(uploadsDir)) {
    return res.status(400).end();
  }

  if (!fs.existsSync(absPath)) {
    return res.status(404).end();
  }

  // 4. Set strict security headers before serving
  const isSensitive = filePath.includes('/id-cards/');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "default-src 'none'");
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');

  res.set('Content-Disposition', 'inline');

  res.sendFile(absPath);
});

// Block direct /uploads/* access entirely (belt-and-suspenders)
app.use('/uploads', (_req, res) => {
  res.status(403).send(`
    <!DOCTYPE html><html lang="th"><head><meta charset="UTF-8">
    <title>ไม่มีสิทธิ์เข้าถึง</title></head>
    <body style="font-family:'Noto Sans Thai',sans-serif;text-align:center;margin-top:80px;">
      <h2>🔒 403 — ไม่อนุญาตให้เข้าถึงโดยตรง</h2>
      <p>ไฟล์นี้ถูกป้องกันตามนโยบาย PDPA</p>
    </body></html>`);
});

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/register', require('./routes/register'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/registrations', require('./routes/registrations'));
app.use('/violations', require('./routes/violations'));
app.use('/violation-reports', require('./routes/violation-reports'));
app.use('/rules', require('./routes/rules'));
app.use('/users', require('./routes/users'));
app.use('/departments', require('./routes/departments'));
app.use('/data', require('./routes/data'));
app.use('/reports', require('./routes/reports'));

// Root redirect
app.get('/', (req, res) => {
  if (req.session.admin) return res.redirect('/dashboard');
  res.redirect('/register');
});

// 404
app.use((req, res) => {
  res.status(404).render('404', { title: 'ไม่พบหน้า' });
});

// Error handler
app.use((err, req, res, next) => {
  // CSRF token ไม่ถูกต้อง — แลสดงข้อความแล้วเด้งกลับหน้าครั้งที่ไประบบรู้จัก (login page)
  if (err.code === 'EBADCSRFTOKEN') {
    try { req.flash('error', '⚠️ Session หมดอายุหรือคำขอไม่ถูกต้อง กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง'); } catch(e) {}
    // Redirect to the GET version of the same page (not 'back' to avoid loop)
    const safeUrl = req.originalUrl.split('?')[0];
    return res.redirect(safeUrl);
  }

  // General errors — render 500 page instead of redirecting (prevents redirect loop)
  console.error('App Error:', err.message);
  res.status(err.status || 500).render('404', { title: 'เกิดข้อผิดพลาด' });
});

// Database init & start
const bcrypt = require('bcrypt');

async function initDB() {
  let conn;
  try {
    conn = await pool.getConnection();
    
    // Create tables
    const schema = fs.readFileSync(path.join(__dirname, 'database', 'schema.sql'), 'utf8');
    const statements = schema.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      await conn.query(stmt);
    }

    // Check if superadmin exists
    const admins = await conn.query('SELECT COUNT(*) as cnt FROM admins');
    if (parseInt(admins[0].cnt) === 0) {
      const hashedPw = await bcrypt.hash('admin123', 10);
      await conn.query(
        'INSERT INTO admins (username, password, full_name, role) VALUES (?, ?, ?, ?)',
        ['admin', hashedPw, 'ผู้ดูแลระบบ', 'superadmin']
      );
      console.log('✅ Created default superadmin: admin / admin123');
    }

    // Seed rules if empty
    const ruleCount = await conn.query('SELECT COUNT(*) as cnt FROM rules');
    if (parseInt(ruleCount[0].cnt) === 0) {
      const seedSQL = fs.readFileSync(path.join(__dirname, 'database', 'seed.sql'), 'utf8');
      const seedStmts = seedSQL.split(';').filter(s => s.trim() && !s.trim().startsWith('--') && !s.trim().toUpperCase().startsWith('USE') && !s.trim().toUpperCase().startsWith('INSERT INTO admins'));
      for (const stmt of seedStmts) {
        try { await conn.query(stmt); } catch(e) { /* ignore seed errors */ }
      }
      console.log('✅ Seeded default rules');
    }

    console.log('✅ Database initialized');
  } catch (err) {
    console.error('❌ Database initialization failed:', err.message);
    console.log('⚠️  Make sure MariaDB is running and check .env settings');
  } finally {
    if (conn) conn.release();
  }
}

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🏍️  BU MotoSpace running at http://localhost:${PORT}`);
  });
});
