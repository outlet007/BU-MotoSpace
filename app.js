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
const SUMMONS_THRESHOLD_KEY = 'summons_total_threshold';
const DEFAULT_SUMMONS_THRESHOLD = 3;

// Ensure upload directories exist (OUTSIDE public/ for PDPA security)
const uploadDirs = [
  'uploads/motorcycles',
  'uploads/plates',
  'uploads/id-cards',
  'uploads/evidence',
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
        registration_id INT NOT NULL,
        scheduled_at DATETIME NOT NULL,
        note TEXT,
        summoned_by INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (registration_id) REFERENCES registrations(id) ON DELETE CASCADE,
        FOREIGN KEY (summoned_by) REFERENCES admins(id) ON DELETE CASCADE,
        INDEX idx_registration_created (registration_id, created_at),
        INDEX idx_scheduled_at (scheduled_at)
      ) ENGINE=InnoDB
    `);

    const settingRows = await pool.query(
      'SELECT setting_value FROM app_settings WHERE setting_key = ?',
      [SUMMONS_THRESHOLD_KEY]
    );
    const thresholdValue = parseInt(settingRows[0] && settingRows[0].setting_value, 10);
    const summonsThreshold = Number.isFinite(thresholdValue) && thresholdValue > 0
      ? thresholdValue
      : DEFAULT_SUMMONS_THRESHOLD;

    const summonsRows = await pool.query(
      `SELECT COUNT(*) as count
       FROM (
         SELECT r.id
         FROM registrations r
         LEFT JOIN (
           SELECT registration_id, MAX(created_at) AS latest_reset_at
           FROM summons_appointments
           GROUP BY registration_id
         ) sa ON sa.registration_id = r.id
         JOIN violations v
           ON v.registration_id = r.id
          AND v.recorded_at > COALESCE(sa.latest_reset_at, '1000-01-01 00:00:00')
         GROUP BY r.id
         HAVING COUNT(v.id) >= ?
       ) candidates`,
      [summonsThreshold]
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
      <body style="font-family:sans-serif;text-align:center;margin-top:80px;">
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
      <body style="font-family:sans-serif;text-align:center;margin-top:80px;">
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
    <body style="font-family:sans-serif;text-align:center;margin-top:80px;">
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
