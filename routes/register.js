const router = require('express').Router();
const pool = require('../config/database');
const upload = require('../middleware/upload');
const { generateHash } = require('../utils/imageHash');
const rateLimit = require('express-rate-limit');
const https = require('https');

// ─── Rate Limiter ─────────────────────────────────────────────────────────────
// จำกัด POST /register ไม่เกิน 5 ครั้ง / 15 นาที / IP
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 นาที
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    req.flash('error', '⚠️ คุณส่งข้อมูลมากเกินไป กรุณารอ 15 นาทีแล้วลองใหม่อีกครั้ง');
    res.redirect('/register');
  },
  skip: (req) => req.method !== 'POST', // ใช้กับ POST เท่านั้น
});

// ─── reCAPTCHA v3 Verify ──────────────────────────────────────────────────────
async function verifyRecaptcha(token) {
  const secretKey = process.env.RECAPTCHA_SECRET_KEY;
  if (!secretKey || !token) return { success: false, score: 0 };

  return new Promise((resolve) => {
    const postData = `secret=${secretKey}&response=${token}`;
    const options = {
      hostname: 'www.google.com',
      path: '/recaptcha/api/siteverify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const reqHttp = https.request(options, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ success: false, score: 0 }); }
      });
    });
    reqHttp.on('error', () => resolve({ success: false, score: 0 }));
    reqHttp.write(postData);
    reqHttp.end();
  });
}

// GET /register - Public registration form
router.get('/', (req, res) => {
  res.render('register', {
    title: 'ลงทะเบียนรถจักรยานยนต์ - BU MotoSpace',
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '',
  });
});

// POST /register
router.post('/', registerLimiter, upload.fields([
  { name: 'motorcycle_photo', maxCount: 1 },
  { name: 'plate_photo', maxCount: 1 },
  { name: 'id_card_photo', maxCount: 1 },
]), async (req, res) => {
  const { user_type, id_number, first_name, last_name, phone, license_plate, province } = req.body;
  let conn;
  try {
    // ─── Layer 1: Honeypot Check ────────────────────────────────────────────
    // Field นี้ซ่อนจาก user จริง — bot มักกรอกทุก field
    const honeypot = req.body.website || '';
    if (honeypot.trim() !== '') {
      // Bot detected — reject แบบเงียบ (ไม่แจ้งว่าถูกตรวจจับ)
      req.flash('success', 'ลงทะเบียนเรียบร้อยแล้ว กรุณารอการอนุมัติจากเจ้าหน้าที่');
      return res.redirect('/register');
    }

    // ─── Layer 2: reCAPTCHA v3 Verification ────────────────────────────────
    const recaptchaToken = req.body.recaptcha_token || '';
    const recaptchaResult = await verifyRecaptcha(recaptchaToken);

    // score ต่ำกว่า 0.5 = น่าสงสัย (bot)
    const score = recaptchaResult.score ?? 0;
    if (!recaptchaResult.success || score < 0.5) {
      console.warn(`[reCAPTCHA] BLOCKED — success=${recaptchaResult.success}, score=${score}, ip=${req.ip}`);
      req.flash('error', '❌ ไม่สามารถยืนยันตัวตนได้ กรุณาลองใหม่อีกครั้ง (reCAPTCHA failed)');
      return res.redirect('/register');
    }

    console.log(`[reCAPTCHA] OK — score=${score}, ip=${req.ip}`);

    // ─── Layer 3: Business Logic ────────────────────────────────────────────
    conn = await pool.getConnection();

    // Check duplicate plate
    const existing = await conn.query('SELECT id FROM registrations WHERE license_plate = ?', [license_plate]);
    if (existing.length > 0) {
      req.flash('error', 'ป้ายทะเบียนนี้ได้ลงทะเบียนไว้แล้ว');
      return res.redirect('/register');
    }

    const motorcyclePhoto = req.files['motorcycle_photo'] ? '/uploads/motorcycles/' + req.files['motorcycle_photo'][0].filename : null;
    const platePhoto = req.files['plate_photo'] ? '/uploads/plates/' + req.files['plate_photo'][0].filename : null;
    const idCardPhoto = req.files['id_card_photo'] ? '/uploads/id-cards/' + req.files['id_card_photo'][0].filename : null;

    const result = await conn.query(
      `INSERT INTO registrations (user_type, id_number, first_name, last_name, phone, license_plate, province, motorcycle_photo, plate_photo, id_card_photo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [user_type, id_number, first_name, last_name, phone, license_plate, province, motorcyclePhoto, platePhoto, idCardPhoto]
    );

    const regId = Number(result.insertId);

    // Generate image hashes for search
    if (req.files['motorcycle_photo']) {
      const hash = await generateHash(req.files['motorcycle_photo'][0].path);
      if (hash) {
        await conn.query('INSERT INTO image_hashes (registration_id, image_type, phash, file_path) VALUES (?, ?, ?, ?)',
          [regId, 'motorcycle', hash, motorcyclePhoto]);
      }
    }
    if (req.files['plate_photo']) {
      const hash = await generateHash(req.files['plate_photo'][0].path);
      if (hash) {
        await conn.query('INSERT INTO image_hashes (registration_id, image_type, phash, file_path) VALUES (?, ?, ?, ?)',
          [regId, 'plate', hash, platePhoto]);
      }
    }

    req.flash('success', 'ลงทะเบียนเรียบร้อยแล้ว กรุณารอการอนุมัติจากเจ้าหน้าที่');
    res.redirect('/register');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด: ' + err.message);
    res.redirect('/register');
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
