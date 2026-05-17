const router = require('express').Router();
const pool = require('../config/database');
const upload = require('../middleware/upload');
const { generateHash } = require('../utils/imageHash');
const rateLimit = require('express-rate-limit');
const https = require('https');
const { verifyCsrf } = require('../middleware/csrf');
const {
  ensureVehicleSchema,
  assertPlateAvailable,
  normalizePlate,
  normalizeCompact,
  normalizeDisplayText,
  findCanonicalOwnerRegistrationId,
  assertOwnerIdentityAvailable,
} = require('../utils/vehicles');

const VALID_USER_TYPES = new Set(['student', 'staff']);
const DUPLICATE_PLATE_MESSAGE = 'ข้อมูลทะเบียนนี้ได้มีการลงทะเบียนไว้แล้ว';

function isDuplicatePlateError(err) {
  return err && (err.code === 'DUPLICATE_PLATE' || err.code === 'ER_DUP_ENTRY' || err.errno === 1062);
}

function flashDuplicatePlatePopup(req) {
  req.flash('duplicatePlatePopup', DUPLICATE_PLATE_MESSAGE);
}

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
  // ── Dev bypass: ข้าม reCAPTCHA เมื่อรันใน development mode ──────────────────
  if (process.env.NODE_ENV === 'development') {
    console.log('[reCAPTCHA] DEV MODE — verification skipped, score=1.0');
    return { success: true, score: 1.0 };
  }

  const secretKey = process.env.RECAPTCHA_SECRET_KEY;
  if (!secretKey || !token) return { success: false, score: 0 };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const postData = new URLSearchParams({
      secret: secretKey,
      response: token,
    }).toString();
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
        try { finish(JSON.parse(data)); }
        catch { finish({ success: false, score: 0 }); }
      });
    });
    reqHttp.setTimeout(5000, () => {
      reqHttp.destroy();
      finish({ success: false, score: 0 });
    });
    reqHttp.on('error', () => finish({ success: false, score: 0 }));
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
  { name: 'motorcycle_photo_2', maxCount: 1 },
  { name: 'plate_photo_2', maxCount: 1 },
  { name: 'id_card_photo', maxCount: 1 },
]), verifyCsrf, async (req, res) => {
  const {
    user_type,
    id_number,
    first_name,
    last_name,
    phone,
    license_plate,
    province,
    license_plate_2,
    province_2,
    has_second_vehicle,
  } = req.body;
  let conn;
  let transactionStarted = false;
  try {
    // ─── Layer 1: Honeypot Check ────────────────────────────────────────────
    // Field นี้ซ่อนจาก user จริง — bot มักกรอกทุก field
    const honeypot = req.body.website || '';
    if (honeypot.trim() !== '') {
      // Bot detected — reject แบบเงียบ (ไม่แจ้งว่าถูกตรวจจับ)
      upload.cleanupUploadedFiles(req);
      req.flash('success', 'ลงทะเบียนเรียบร้อยแล้ว กรุณารอการอนุมัติจากเจ้าหน้าที่');
      return res.redirect('/register');
    }

    const cleanUserType = VALID_USER_TYPES.has(user_type) ? user_type : null;
    const cleanIdNumber = normalizeCompact(id_number);
    const cleanFirstName = normalizeDisplayText(first_name);
    const cleanLastName = normalizeDisplayText(last_name);
    const cleanPhone = (phone || '').trim();
    const cleanLicensePlate = normalizePlate(license_plate);
    const cleanProvince = normalizeDisplayText(province);
    const hasSecondVehicle = has_second_vehicle === 'on';
    const cleanLicensePlate2 = hasSecondVehicle ? normalizePlate(license_plate_2) : '';
    const cleanProvince2 = hasSecondVehicle ? normalizeDisplayText(province_2) : '';

    if (!cleanUserType || !cleanIdNumber || !cleanFirstName || !cleanLastName || !cleanPhone || !cleanLicensePlate || !cleanProvince) {
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'กรุณากรอกข้อมูลให้ครบถ้วน');
      return res.redirect('/register');
    }
    const rawIdNumber = (id_number || '').trim();
    const isValidStudentId = cleanUserType === 'student' && /^[0-9]{10}$/.test(rawIdNumber);
    const isValidStaffId = cleanUserType === 'staff' && /^[A-Za-z0-9]{6}$/.test(rawIdNumber);
    if (!isValidStudentId && !isValidStaffId) {
      upload.cleanupUploadedFiles(req);
      req.flash('error', cleanUserType === 'student'
        ? 'กรุณากรอกรหัสนักศึกษาเป็นตัวเลข 10 ตัว และห้ามมีช่องว่าง'
        : 'กรุณากรอกรหัสอาจารย์/บุคลากรเป็นตัวอักษรหรือตัวเลขรวม 6 ตัว และห้ามมีช่องว่าง');
      return res.redirect('/register');
    }
    if (!/^[0-9]{10}$/.test(cleanPhone)) {
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'กรุณากรอกเบอร์โทรศัพท์เป็นตัวเลข 10 หลักเท่านั้น');
      return res.redirect('/register');
    }
    if (hasSecondVehicle && (!cleanLicensePlate2 || !cleanProvince2)) {
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'กรุณากรอกข้อมูลรถคันที่ 2 ให้ครบถ้วน');
      return res.redirect('/register');
    }
    if (hasSecondVehicle && normalizePlate(cleanLicensePlate2) === normalizePlate(cleanLicensePlate)) {
      upload.cleanupUploadedFiles(req);
      flashDuplicatePlatePopup(req);
      return res.redirect('/register');
    }

    const hasIdCardPhoto = Boolean(req.files && req.files.id_card_photo && req.files.id_card_photo[0]);
    const hasMotorcyclePhoto = Boolean(req.files && req.files.motorcycle_photo && req.files.motorcycle_photo[0]);
    const hasPlatePhoto = Boolean(req.files && req.files.plate_photo && req.files.plate_photo[0]);
    const hasMotorcyclePhoto2 = Boolean(req.files && req.files.motorcycle_photo_2 && req.files.motorcycle_photo_2[0]);
    const hasPlatePhoto2 = Boolean(req.files && req.files.plate_photo_2 && req.files.plate_photo_2[0]);

    if (!hasIdCardPhoto || !hasMotorcyclePhoto || !hasPlatePhoto) {
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'กรุณาอัปโหลดรูปถ่ายบัตร รูปรถจักรยานยนต์ และรูปป้ายทะเบียนให้ครบถ้วน');
      return res.redirect('/register');
    }
    if (hasSecondVehicle && (!hasMotorcyclePhoto2 || !hasPlatePhoto2)) {
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'กรุณาอัปโหลดรูปรถจักรยานยนต์และรูปป้ายทะเบียนของรถคันที่ 2 ให้ครบถ้วน');
      return res.redirect('/register');
    }

    // ─── Layer 2: reCAPTCHA v3 Verification ────────────────────────────────
    const recaptchaToken = req.body.recaptcha_token || '';
    const recaptchaResult = await verifyRecaptcha(recaptchaToken);

    // score ต่ำกว่า 0.5 = น่าสงสัย (bot)
    const score = recaptchaResult.score ?? 0;
    if (!recaptchaResult.success || score < 0.5) {
      console.warn(`[reCAPTCHA] BLOCKED — success=${recaptchaResult.success}, score=${score}, ip=${req.ip}`);
      upload.cleanupUploadedFiles(req);
      req.flash('error', '❌ ไม่สามารถยืนยันตัวตนได้ กรุณาลองใหม่อีกครั้ง (reCAPTCHA failed)');
      return res.redirect('/register');
    }

    console.log(`[reCAPTCHA] OK — score=${score}, ip=${req.ip}`);

    // ─── Layer 3: Business Logic ────────────────────────────────────────────
    conn = await pool.getConnection();
    await conn.beginTransaction();
    transactionStarted = true;
    await ensureVehicleSchema(conn);

    await assertOwnerIdentityAvailable(conn, cleanUserType, cleanIdNumber, cleanFirstName, cleanLastName);

    // Check duplicate plate
    try {
      await assertPlateAvailable(conn, cleanLicensePlate);
      if (hasSecondVehicle) {
        await assertPlateAvailable(conn, cleanLicensePlate2);
      }
    } catch (err) {
      await conn.rollback();
      transactionStarted = false;
      upload.cleanupUploadedFiles(req);
      if (isDuplicatePlateError(err)) {
        flashDuplicatePlatePopup(req);
      } else {
        req.flash('error', 'ข้อมูลทะเบียนรถไม่ถูกต้อง');
      }
      return res.redirect('/register');
    }

    const motorcyclePhoto = req.files['motorcycle_photo'] ? '/uploads/motorcycles/' + req.files['motorcycle_photo'][0].filename : null;
    const platePhoto = req.files['plate_photo'] ? '/uploads/plates/' + req.files['plate_photo'][0].filename : null;
    const motorcyclePhoto2 = req.files['motorcycle_photo_2'] ? '/uploads/motorcycles/' + req.files['motorcycle_photo_2'][0].filename : null;
    const platePhoto2 = req.files['plate_photo_2'] ? '/uploads/plates/' + req.files['plate_photo_2'][0].filename : null;
    const idCardPhoto = req.files['id_card_photo'] ? '/uploads/id-cards/' + req.files['id_card_photo'][0].filename : null;

    const result = await conn.query(
      `INSERT INTO registrations (user_type, id_number, first_name, last_name, phone, license_plate, province, motorcycle_photo, plate_photo, id_card_photo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cleanUserType, cleanIdNumber, cleanFirstName, cleanLastName, cleanPhone, cleanLicensePlate, cleanProvince, motorcyclePhoto, platePhoto, idCardPhoto]
    );

    const regId = Number(result.insertId);
    const ownerRegistrationId = await findCanonicalOwnerRegistrationId(conn, cleanUserType, cleanIdNumber, regId);

    await conn.query(
      `INSERT INTO vehicles (
        owner_registration_id,
        source_registration_id,
        license_plate,
        normalized_plate,
        province,
        motorcycle_photo,
        plate_photo,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
      [ownerRegistrationId, regId, cleanLicensePlate, normalizePlate(cleanLicensePlate), cleanProvince, motorcyclePhoto, platePhoto]
    );

    if (hasSecondVehicle) {
      await conn.query(
        `INSERT INTO vehicles (
          owner_registration_id,
          source_registration_id,
          license_plate,
          normalized_plate,
          province,
          motorcycle_photo,
          plate_photo,
          status,
          created_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, 'pending', NOW())`,
        [ownerRegistrationId, cleanLicensePlate2, normalizePlate(cleanLicensePlate2), cleanProvince2, motorcyclePhoto2, platePhoto2]
      );
    }

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
    if (req.files['motorcycle_photo_2']) {
      const hash = await generateHash(req.files['motorcycle_photo_2'][0].path);
      if (hash) {
        await conn.query('INSERT INTO image_hashes (registration_id, image_type, phash, file_path) VALUES (?, ?, ?, ?)',
          [ownerRegistrationId, 'motorcycle', hash, motorcyclePhoto2]);
      }
    }
    if (req.files['plate_photo_2']) {
      const hash = await generateHash(req.files['plate_photo_2'][0].path);
      if (hash) {
        await conn.query('INSERT INTO image_hashes (registration_id, image_type, phash, file_path) VALUES (?, ?, ?, ?)',
          [ownerRegistrationId, 'plate', hash, platePhoto2]);
      }
    }

    await conn.commit();
    transactionStarted = false;
    req.flash('success', 'ลงทะเบียนเรียบร้อยแล้ว กรุณารอการอนุมัติจากเจ้าหน้าที่');
    res.redirect('/register');
  } catch (err) {
    console.error(err);
    if (transactionStarted && conn) {
      await conn.rollback().catch(() => {});
    }
    upload.cleanupUploadedFiles(req);
    if (isDuplicatePlateError(err)) {
      flashDuplicatePlatePopup(req);
    } else if (err.code === 'OWNER_IDENTITY_MISMATCH') {
      req.flash('error', 'พบรหัสนี้ในระบบแล้ว แต่ชื่อ-นามสกุลไม่ตรงกับข้อมูลเดิม กรุณาตรวจสอบข้อมูลอีกครั้ง');
    } else {
      req.flash('error', 'เกิดข้อผิดพลาดในการลงทะเบียน กรุณาลองใหม่อีกครั้ง');
    }
    res.redirect('/register');
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
