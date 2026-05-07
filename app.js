const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
require('dotenv').config();
const { csrfMiddleware, generateCsrfToken } = require('./middleware/csrf');
const { idleSessionTimeout } = require('./middleware/auth');
const MariaDbSessionStore = require('./utils/mariadbSessionStore');
const cleanupUploadedFiles = require('./middleware/upload').cleanupUploadedFiles;

// ตั้งค่า Timezone ของระบบเป็นประเทศไทย (UTC+7)
process.env.TZ = 'Asia/Bangkok';
const pool = require('./config/database');
const { generateSignedUrl, verifySignedUrl, resolveFilePath } = require('./utils/signedUrl');

const app = express();
const PORT = process.env.APP_PORT || 3000;
const DEFAULT_SUMMONS_THRESHOLD = 3;
const NAV_COUNTER_CACHE_TTL_MS = 10 * 1000;
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'bu_motospace.sid';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const sessionStore = new MariaDbSessionStore(pool);
let navCounterCache = { expiresAt: 0, values: null };

function validateRuntimeConfig() {
  if (!IS_PRODUCTION) return;

  const requiredSecrets = [
    ['SESSION_SECRET', process.env.SESSION_SECRET],
    ['IMAGE_SECRET', process.env.IMAGE_SECRET],
  ];

  requiredSecrets.forEach(([name, value]) => {
    if (!value || value.length < 32) {
      throw new Error(`${name} must be set to at least 32 characters in production`);
    }
  });
}

validateRuntimeConfig();

if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}

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
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  name: SESSION_COOKIE_NAME,
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'development_session_secret_change_me',
  resave: false,
  saveUninitialized: false,
  proxy: IS_PRODUCTION,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,               // ป้องกัน JS อ่าน cookie
    sameSite: 'lax',              // ป้องกัน CSRF ขั้นพื้นฐาน
    secure: IS_PRODUCTION,         // HTTPS only in production
  },
}));
app.use(flash());

// ─── CSRF Protection (Session-based Synchronizer Token) ────────────────────────
// ใช้ csrf middleware ที่เขียนเอง โดยใช้ Node.js crypto (built-in) ไม่ต้องติดตั้ง package เพิ่ม
app.use(csrfMiddleware);

// ─── Idle Session Timeout (1 ชั่วโมง) ───────────────────────────────────
// ตรวจสอบทุก request ว่าเวลาของ session ได้หมดอายุเนื่องจากไม่มีการใช้งานหรือยัง
app.use(idleSessionTimeout);

async function countSummonsCandidates() {
  const rows = await pool.query(
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
     ) candidates`
  );

  return Number(rows[0] && rows[0].count) || 0;
}

async function getNavbarCounters() {
  const now = Date.now();
  if (navCounterCache.values && navCounterCache.expiresAt > now) {
    return navCounterCache.values;
  }

  const [pendingRows, pendingReportRows, summonsCandidatesCount] = await Promise.all([
    pool.query("SELECT COUNT(*) as count FROM registrations WHERE status = 'pending'"),
    pool.query("SELECT COUNT(*) as count FROM violation_reports WHERE status = 'pending'"),
    countSummonsCandidates(),
  ]);

  navCounterCache = {
    expiresAt: now + NAV_COUNTER_CACHE_TTL_MS,
    values: {
      pendingCount: Number(pendingRows[0] && pendingRows[0].count) || 0,
      pendingReportsCount: Number(pendingReportRows[0] && pendingReportRows[0].count) || 0,
      summonsCandidatesCount,
    },
  };

  return navCounterCache.values;
}

// Global template variables
app.use(async (req, res, next) => {
  res.locals.admin = req.session.admin || null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.currentPath = req.path;
  res.locals.currentUrl = req.originalUrl;
  res.locals.csrfToken = generateCsrfToken(req);
  res.locals.signedUrl = (filePath) => filePath ? generateSignedUrl(filePath) : '';
  res.locals.pendingCount = 0;
  res.locals.pendingReportsCount = 0;
  res.locals.summonsCandidatesCount = 0;

  if (!req.session.admin) return next();

  try {
    const counters = await getNavbarCounters();
    res.locals.pendingCount = counters.pendingCount;
    res.locals.pendingReportsCount = counters.pendingReportsCount;
    res.locals.summonsCandidatesCount = counters.summonsCandidatesCount;
  } catch (err) {
    console.error('Error fetching navbar counters:', err.message);
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
  const uploadsDir = path.resolve(__dirname, 'uploads');
  if (!absPath.startsWith(uploadsDir + path.sep)) {
    return res.status(400).end();
  }

  if (!fs.existsSync(absPath)) {
    return res.status(404).end();
  }

  // 4. Set strict security headers before serving
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
  if (cleanupUploadedFiles) cleanupUploadedFiles(req);

  if (err.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'ไฟล์มีขนาดใหญ่เกิน 10MB'
      : 'ไม่สามารถอัปโหลดไฟล์ได้';
    try { req.flash('error', message); } catch(e) {}
    return res.redirect(req.get('referer') || '/dashboard');
  }

  if (err.code === 'EUPLOADTYPE') {
    try { req.flash('error', err.message || 'ชนิดไฟล์ไม่ถูกต้อง'); } catch(e) {}
    return res.redirect(req.get('referer') || '/dashboard');
  }

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

async function columnExists(conn, tableName, columnName) {
  const [row] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return Number(row && row.cnt) > 0;
}

async function indexExists(conn, tableName, indexName) {
  const [row] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = ?`,
    [tableName, indexName]
  );
  return Number(row && row.cnt) > 0;
}

async function ensureColumn(conn, tableName, columnName, definition) {
  if (!(await columnExists(conn, tableName, columnName))) {
    await conn.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

async function ensureIndex(conn, tableName, indexName, definition) {
  if (!(await indexExists(conn, tableName, indexName))) {
    await conn.query(`ALTER TABLE ${tableName} ADD ${definition}`);
  }
}

async function ensureRuntimeSchema(conn) {
  await ensureColumn(conn, 'admins', 'email', 'VARCHAR(200) DEFAULT NULL');
  await ensureColumn(conn, 'admins', 'phone', 'VARCHAR(20) DEFAULT NULL');
  await ensureColumn(conn, 'admins', 'department_id', 'INT DEFAULT NULL');

  await ensureColumn(conn, 'rules', 'violation_type_id', 'INT DEFAULT NULL AFTER description');
  await ensureColumn(conn, 'rules', 'penalty_type_id', 'INT DEFAULT NULL AFTER violation_type_id');
  await ensureIndex(conn, 'rules', 'idx_rules_violation_type', 'INDEX idx_rules_violation_type (violation_type_id)');
  await ensureIndex(conn, 'rules', 'idx_rules_penalty_type', 'INDEX idx_rules_penalty_type (penalty_type_id)');
  await ensureIndex(conn, 'violations', 'idx_violations_registration_rule_recorded', 'INDEX idx_violations_registration_rule_recorded (registration_id, rule_id, recorded_at)');

  await ensureColumn(conn, 'summons_appointments', 'appointment_code', 'VARCHAR(30) DEFAULT NULL AFTER id');
  await ensureColumn(conn, 'summons_appointments', 'written_document', 'VARCHAR(500) DEFAULT NULL');
  await ensureColumn(conn, 'summons_appointments', 'written_document_original_name', 'VARCHAR(255) DEFAULT NULL');
  await ensureColumn(conn, 'summons_appointments', 'violation_type_id', 'INT DEFAULT NULL');
  await ensureIndex(conn, 'summons_appointments', 'uq_summons_appointment_code', 'UNIQUE INDEX uq_summons_appointment_code (appointment_code)');
  await ensureIndex(conn, 'summons_appointments', 'idx_summons_violation_type', 'INDEX idx_summons_violation_type (violation_type_id)');

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

  await sessionStore.ready();
}

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

    await ensureRuntimeSchema(conn);

    // Check if superadmin exists
    const admins = await conn.query('SELECT COUNT(*) as cnt FROM admins');
    if (parseInt(admins[0].cnt) === 0) {
      const defaultAdminUsername = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
      const defaultAdminPassword = process.env.DEFAULT_ADMIN_PASSWORD || (IS_PRODUCTION ? '' : 'admin123');

      if (!defaultAdminPassword || (IS_PRODUCTION && defaultAdminPassword.length < 12)) {
        throw new Error('DEFAULT_ADMIN_PASSWORD must be set to at least 12 characters before creating the first production admin');
      }

      const hashedPw = await bcrypt.hash(defaultAdminPassword, 10);
      await conn.query(
        'INSERT INTO admins (username, password, full_name, role) VALUES (?, ?, ?, ?)',
        [defaultAdminUsername, hashedPw, 'ผู้ดูแลระบบ', 'superadmin']
      );
      console.log(`✅ Created default superadmin: ${defaultAdminUsername}`);
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
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🏍️  BU MotoSpace running at http://localhost:${PORT}`);
  });
}).catch(() => {
  process.exit(1);
});
