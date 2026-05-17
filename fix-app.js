/**
 * fix-app.js — one-shot patch script
 * Replaces broken lines 268-357 in app.js with correct content.
 * Run: node fix-app.js
 */
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'app.js');
const lines = fs.readFileSync(filePath, 'utf8').split('\n');

// Keep lines 1-267 (index 0-266) and 358+ (index 357+)
const head = lines.slice(0, 267);   // index 0-266 inclusive
const tail = lines.slice(357);       // index 357+ (Database init & start)

const newSection = [
  '',
  '// Block direct /uploads/* access entirely (belt-and-suspenders)',
  "app.use('/uploads', (_req, res) => {",
  '  res.status(403).send(`',
  "    <!DOCTYPE html><html lang=\"th\"><head><meta charset=\"UTF-8\">",
  "    <title>\\u0e44\\u0e21\\u0e48\\u0e21\\u0e35\\u0e2a\\u0e34\\u0e17\\u0e18\\u0e34\\u0e4c\\u0e40\\u0e02\\u0e49\\u0e32\\u0e16\\u0e36\\u0e07</title></head>",
  "    <body style=\"font-family:'Noto Sans Thai',sans-serif;text-align:center;margin-top:80px;\">",
  "      <h2>\\ud83d\\udd12 403 \\u2014 \\u0e44\\u0e21\\u0e48\\u0e2d\\u0e19\\u0e38\\u0e0d\\u0e32\\u0e15\\u0e43\\u0e2b\\u0e49\\u0e40\\u0e02\\u0e49\\u0e32\\u0e16\\u0e36\\u0e07\\u0e42\\u0e14\\u0e22\\u0e15\\u0e23\\u0e07</h2>",
  "      <p>\\u0e44\\u0e1f\\u0e25\\u0e4c\\u0e19\\u0e35\\u0e49\\u0e16\\u0e39\\u0e01\\u0e1b\\u0e49\\u0e2d\\u0e07\\u0e01\\u0e31\\u0e19\\u0e15\\u0e32\\u0e21\\u0e19\\u0e42\\u0e22\\u0e1a\\u0e32\\u0e22 PDPA</p>",
  '    </body></html>`);',
  '});',
  '',
  '// Routes',
  "app.use('/auth', require('./routes/auth'));",
  "app.use('/register', require('./routes/register'));",
  "app.use('/dashboard', require('./routes/dashboard'));",
  "app.use('/registrations', require('./routes/registrations'));",
  "app.use('/violations', require('./routes/violations'));",
  "app.use('/violation-reports', require('./routes/violation-reports'));",
  "app.use('/rules', require('./routes/rules'));",
  "app.use('/users', require('./routes/users'));",
  "app.use('/departments', require('./routes/departments'));",
  "app.use('/data', require('./routes/data'));",
  "app.use('/reports', require('./routes/reports'));",
  '',
  '// Root redirect',
  "app.get('/', (req, res) => {",
  '  if (req.session.admin) return res.redirect(\'/dashboard\');',
  "  res.redirect('/register');",
  '});',
  '',
  '// 404',
  'app.use((req, res) => {',
  "  res.status(404).render('404', { title: '\\u0e44\\u0e21\\u0e48\\u0e1e\\u0e1a\\u0e2b\\u0e19\\u0e49\\u0e32' });",
  '});',
  '',
  '// Error handler',
  'app.use((err, req, res, next) => {',
  '  if (cleanupUploadedFiles) cleanupUploadedFiles(req);',
  '',
  '  if (err.name === \'MulterError\') {',
  "    const message = err.code === 'LIMIT_FILE_SIZE'",
  "      ? '\\u0e44\\u0e1f\\u0e25\\u0e4c\\u0e21\\u0e35\\u0e02\\u0e19\\u0e32\\u0e14\\u0e43\\u0e2b\\u0e0d\\u0e48\\u0e40\\u0e01\\u0e34\\u0e19 10MB'",
  "      : '\\u0e44\\u0e21\\u0e48\\u0e2a\\u0e32\\u0e21\\u0e32\\u0e23\\u0e16\\u0e2d\\u0e31\\u0e1b\\u0e42\\u0e2b\\u0e25\\u0e14\\u0e44\\u0e1f\\u0e25\\u0e4c\\u0e44\\u0e14\\u0e49';",
  "    try { req.flash('error', message); } catch(e) {}",
  "    return res.redirect(req.get('referer') || '/dashboard');",
  '  }',
  '',
  "  if (err.code === 'EUPLOADTYPE') {",
  "    try { req.flash('error', err.message || '\\u0e0a\\u0e19\\u0e34\\u0e14\\u0e44\\u0e1f\\u0e25\\u0e4c\\u0e44\\u0e21\\u0e48\\u0e16\\u0e39\\u0e01\\u0e15\\u0e49\\u0e2d\\u0e07'); } catch(e) {}",
  "    return res.redirect(req.get('referer') || '/dashboard');",
  '  }',
  '',
  '  // CSRF token',
  "  if (err.code === 'EBADCSRFTOKEN') {",
  "    try { req.flash('error', '\\u26a0\\ufe0f Session \\u0e2b\\u0e21\\u0e14\\u0e2d\\u0e32\\u0e22\\u0e38\\u0e2b\\u0e23\\u0e37\\u0e2d\\u0e04\\u0e33\\u0e02\\u0e2d\\u0e44\\u0e21\\u0e48\\u0e16\\u0e39\\u0e01\\u0e15\\u0e49\\u0e2d\\u0e07 \\u0e01\\u0e23\\u0e38\\u0e13\\u0e32\\u0e42\\u0e2b\\u0e25\\u0e14\\u0e2b\\u0e19\\u0e49\\u0e32\\u0e43\\u0e2b\\u0e21\\u0e48\\u0e41\\u0e25\\u0e49\\u0e27\\u0e25\\u0e2d\\u0e07\\u0e2d\\u0e35\\u0e01\\u0e04\\u0e23\\u0e31\\u0e49\\u0e07'); } catch(e) {}",
  "    const safeUrl = req.originalUrl.split('?')[0];",
  '    return res.redirect(safeUrl);',
  '  }',
  '',
  '  // Image resize / sharp error',
  '  if (',
  '    err.message && (',
  "      err.message.includes('Input file') ||",
  "      err.message.includes('sharp') ||",
  "      err.message.includes('resize') ||",
  "      (err.code && String(err.code).startsWith('E'))",
  '    )',
  '  ) {',
  "    console.error('[Upload/Image Error]', err.message);",
  "    const imgErrReferer = req.get('referer');",
  "    const imgErrFallback = imgErrReferer && imgErrReferer.includes('/register')",
  "      ? '/register' : (imgErrReferer || '/register');",
  "    try { req.flash('error', '\\u0e44\\u0e21\\u0e48\\u0e2a\\u0e32\\u0e21\\u0e32\\u0e23\\u0e16\\u0e1b\\u0e23\\u0e30\\u0e21\\u0e27\\u0e25\\u0e1c\\u0e25\\u0e44\\u0e1f\\u0e25\\u0e4c\\u0e23\\u0e39\\u0e1b\\u0e20\\u0e32\\u0e1e\\u0e44\\u0e14\\u0e49 \\u0e01\\u0e23\\u0e38\\u0e13\\u0e32\\u0e25\\u0e2d\\u0e07\\u0e43\\u0e2b\\u0e21\\u0e48\\u0e2d\\u0e35\\u0e01\\u0e04\\u0e23\\u0e31\\u0e49\\u0e07'); } catch(e) {}",
  '    return res.redirect(imgErrFallback);',
  '  }',
  '',
  '  // General errors',
  "  console.error('App Error:', err.message, err.stack);",
  "  const errReferer = req.get('referer') || '';",
  "  if (errReferer.includes('/register') || req.originalUrl.includes('/register')) {",
  "    try { req.flash('error', '\\u0e40\\u0e01\\u0e34\\u0e14\\u0e02\\u0e49\\u0e2d\\u0e1c\\u0e34\\u0e14\\u0e1e\\u0e25\\u0e32\\u0e14\\u0e43\\u0e19\\u0e01\\u0e32\\u0e23\\u0e25\\u0e07\\u0e17\\u0e30\\u0e40\\u0e1a\\u0e35\\u0e22\\u0e19 \\u0e01\\u0e23\\u0e38\\u0e13\\u0e32\\u0e25\\u0e2d\\u0e07\\u0e43\\u0e2b\\u0e21\\u0e48\\u0e2d\\u0e35\\u0e01\\u0e04\\u0e23\\u0e31\\u0e49\\u0e07'); } catch(e) {}",
  "    return res.redirect('/register');",
  '  }',
  "  res.status(err.status || 500).render('404', { title: '\\u0e40\\u0e01\\u0e14\\u0e02\\u0e49\\u0e2d\\u0e1c\\u0e14\\u0e1e\\u0e25\\u0e32\\u0e14' });",
  '});',
  '',
];

const result = [...head, ...newSection, ...tail].join('\n');
fs.writeFileSync(filePath, result, 'utf8');
console.log('✅ app.js patched successfully!');
console.log('Head lines:', head.length);
console.log('New section lines:', newSection.length);
console.log('Tail lines:', tail.length);
console.log('Total lines:', head.length + newSection.length + tail.length);
