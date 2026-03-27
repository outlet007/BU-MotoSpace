const router = require('express').Router();
const pool = require('../config/database');
const upload = require('../middleware/upload');
const { generateHash } = require('../utils/imageHash');

// GET /register - Public registration form
router.get('/', (req, res) => {
  res.render('register', { title: 'ลงทะเบียนรถจักรยานยนต์ - BU MotoSpace' });
});

// POST /register
router.post('/', upload.fields([
  { name: 'motorcycle_photo', maxCount: 1 },
  { name: 'plate_photo', maxCount: 1 },
  { name: 'id_card_photo', maxCount: 1 },
]), async (req, res) => {
  const { user_type, id_number, first_name, last_name, phone, license_plate, province } = req.body;
  let conn;
  try {
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
