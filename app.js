const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const pool = require('./config/database');

const app = express();
const PORT = process.env.APP_PORT || 3000;

// Ensure upload directories exist
const uploadDirs = [
  'public/uploads/motorcycles',
  'public/uploads/plates',
  'public/uploads/id-cards',
  'public/uploads/evidence',
  'public/uploads/temp',
  'public/uploads/misc',
];
uploadDirs.forEach(dir => {
  const fullPath = path.join(__dirname, dir);
  if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
});

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middlewares
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));
app.use(flash());

// Global template variables
app.use(async (req, res, next) => {
  res.locals.admin = req.session.admin || null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.currentPath = req.path;
  res.locals.currentUrl = req.originalUrl;
  
  try {
    const rows = await pool.query("SELECT COUNT(*) as count FROM registrations WHERE status = 'pending'");
    res.locals.pendingCount = Number(rows[0].count);
  } catch(e) {
    console.error('Error fetching pendingCount:', e);
    res.locals.pendingCount = 0;
  }
  
  next();
});

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/register', require('./routes/register'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/registrations', require('./routes/registrations'));
app.use('/violations', require('./routes/violations'));
app.use('/rules', require('./routes/rules'));
app.use('/users', require('./routes/users'));
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
  console.error('App Error:', err.message);
  const referrer = req.get('Referrer') || '/dashboard';
  try {
    req.flash('error', err.message || 'เกิดข้อผิดพลาด');
  } catch(e) { /* flash might not be available */ }
  res.redirect(referrer);
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
