/**
 * fix-app2.js — rewrites the broken middle section of app.js
 * Takes head (lines 1-229), injects correct middle, keeps tail (line 365+)
 * Run: node fix-app2.js
 */
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'app.js');
const lines = fs.readFileSync(filePath, 'utf8').split('\n');

console.log('Total lines in file:', lines.length);

// head = lines 1-229 (index 0-228)
const head = lines.slice(0, 229);

// tail = "// Database init & start" onwards
// Find the line index that starts with "// Database init"
let tailStart = -1;
for (let i = 229; i < lines.length; i++) {
  if (lines[i].includes('// Database init')) {
    tailStart = i;
    break;
  }
}

if (tailStart === -1) {
  console.error('❌ Could not find "// Database init" marker. Aborting.');
  process.exit(1);
}

console.log('Tail starts at line:', tailStart + 1);
const tail = lines.slice(tailStart);

const middle = `
  if (!filePath) {
    return res.status(403).send(\`
      <!DOCTYPE html><html lang="th"><head><meta charset="UTF-8">
      <title>ลิงก์หมดอายุ</title></head>
      <body style="font-family:'Noto Sans Thai',sans-serif;text-align:center;margin-top:80px;">
        <h2>⏰ 403 — ลิงก์หมดอายุหรือไม่ถูกต้อง</h2>
        <p>ลิงก์รูปภาพนี้หมดอายุแล้ว (15 นาที) กรุณาโหลดหน้าใหม่เพื่อรับลิงก์ใหม่</p>
        <button onclick="history.back()">← กลับ</button>
      </body></html>\`);
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
  res.status(403).send(\`
    <!DOCTYPE html><html lang="th"><head><meta charset="UTF-8">
    <title>ไม่มีสิทธิ์เข้าถึง</title></head>
    <body style="font-family:'Noto Sans Thai',sans-serif;text-align:center;margin-top:80px;">
      <h2>🔒 403 — ไม่อนุญาตให้เข้าถึงโดยตรง</h2>
      <p>ไฟล์นี้ถูกป้องกันตามนโยบาย PDPA</p>
    </body></html>\`);
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

  // CSRF token ไม่ถูกต้อง
  if (err.code === 'EBADCSRFTOKEN') {
    try { req.flash('error', '⚠️ Session หมดอายุหรือคำขอไม่ถูกต้อง กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง'); } catch(e) {}
    const safeUrl = req.originalUrl.split('?')[0];
    return res.redirect(safeUrl);
  }

  // Image resize / sharp error — redirect กลับฟอร์มแทน render 404
  if (
    err.message && (
      err.message.includes('Input file') ||
      err.message.includes('sharp') ||
      err.message.includes('resize') ||
      (err.code && String(err.code).startsWith('E'))
    )
  ) {
    console.error('[Upload/Image Error]', err.message);
    const imgErrReferer = req.get('referer');
    const imgErrFallback = imgErrReferer && imgErrReferer.includes('/register')
      ? '/register' : (imgErrReferer || '/register');
    try { req.flash('error', 'ไม่สามารถประมวลผลไฟล์รูปภาพได้ กรุณาลองใหม่อีกครั้ง'); } catch(e) {}
    return res.redirect(imgErrFallback);
  }

  // General errors
  console.error('App Error:', err.message, err.stack);
  const errReferer = req.get('referer') || '';
  if (errReferer.includes('/register') || req.originalUrl.includes('/register')) {
    try { req.flash('error', 'เกิดข้อผิดพลาดในการลงทะเบียน กรุณาลองใหม่อีกครั้ง'); } catch(e) {}
    return res.redirect('/register');
  }
  res.status(err.status || 500).render('404', { title: 'เกิดข้อผิดพลาด' });
});

`.split('\n');

const result = [...head, ...middle, ...tail].join('\n');
fs.writeFileSync(filePath, result, 'utf8');

const finalLines = result.split('\n').length;
console.log('✅ app.js fixed successfully!');
console.log('Head lines:', head.length);
console.log('Middle lines:', middle.length);
console.log('Tail lines:', tail.length);
console.log('Total lines:', finalLines);
