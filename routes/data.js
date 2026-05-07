const router = require('express').Router();
const pool = require('../config/database');
const { isAuthenticated, isHead } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { verifyCsrf } = require('../middleware/csrf');
const { Parser } = require('json2csv');
const fs = require('fs');
const xlsx = require('xlsx');
const csvParser = require('csv-parser');

router.use(isAuthenticated, isHead);

const configuredImportLimit = parseInt(process.env.MAX_IMPORT_ROWS || '5000', 10);
const MAX_IMPORT_ROWS = Number.isFinite(configuredImportLimit) && configuredImportLimit > 0
  ? configuredImportLimit
  : 5000;

// Redirect /data to /data/import
router.get('/', (req, res) => {
  res.redirect('/data/import');
});

// GET /data/import
router.get('/import', async (req, res) => {
  res.render('data/import', { title: 'นำเข้าข้อมูล - BU MotoSpace' });
});

// GET /data/export
router.get('/export', async (req, res) => {
  res.render('data/export', { title: 'ส่งออกข้อมูล - BU MotoSpace' });
});

// GET /data/import/template
router.get('/import/template', (req, res) => {
  const wsData = [
    ['ประเภท', 'รหัส', 'ชื่อ', 'นามสกุล', 'โทรศัพท์', 'ป้ายทะเบียน', 'จังหวัด'],
    ['student', '6501234', 'สมชาย', 'ใจดี', '0812345678', 'กข 1234', 'กรุงเทพมหานคร'],
    ['staff', 'T001', 'สมหญิง', 'รักดี', '', '1กข 5678', 'นนทบุรี']
  ];
  
  const ws = xlsx.utils.aoa_to_sheet(wsData);
  
  // Set column widths
  ws['!cols'] = [
    { wch: 10 }, // ประเภท
    { wch: 15 }, // รหัส
    { wch: 20 }, // ชื่อ
    { wch: 20 }, // นามสกุล
    { wch: 15 }, // โทรศัพท์
    { wch: 15 }, // ป้ายทะเบียน
    { wch: 20 }  // จังหวัด
  ];

  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Template');

  const fileBuffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename="registration_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(fileBuffer);
});

// GET /data/export/registrations
router.get('/export/registrations', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      'SELECT id, user_type, id_number, first_name, last_name, phone, license_plate, province, status, registered_at FROM registrations ORDER BY registered_at DESC'
    );

    const fields = [
      { label: 'ID', value: 'id' },
      { label: 'ประเภท', value: 'user_type' },
      { label: 'รหัส', value: 'id_number' },
      { label: 'ชื่อ', value: 'first_name' },
      { label: 'นามสกุล', value: 'last_name' },
      { label: 'โทรศัพท์', value: 'phone' },
      { label: 'ป้ายทะเบียน', value: 'license_plate' },
      { label: 'จังหวัด', value: 'province' },
      { label: 'สถานะ', value: 'status' },
      { label: 'วันที่ลงทะเบียน', value: 'registered_at' },
    ];
    const parser = new Parser({ fields, withBOM: true });
    const csv = parser.parse(rows);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=registrations.csv');
    res.send(csv);
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถส่งออกข้อมูลได้');
    res.redirect('/data/export');
  } finally {
    if (conn) conn.release();
  }
});

// GET /data/export/violations
router.get('/export/violations', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT v.id, r.id_number, r.first_name, r.last_name, r.license_plate, ru.rule_name, v.description, v.recorded_at
       FROM violations v
       JOIN registrations r ON v.registration_id = r.id
       JOIN rules ru ON v.rule_id = ru.id
       ORDER BY v.recorded_at DESC`
    );

    const fields = [
      { label: 'ID', value: 'id' },
      { label: 'รหัส', value: 'id_number' },
      { label: 'ชื่อ', value: 'first_name' },
      { label: 'นามสกุล', value: 'last_name' },
      { label: 'ป้ายทะเบียน', value: 'license_plate' },
      { label: 'กฎที่ฝ่าฝืน', value: 'rule_name' },
      { label: 'รายละเอียด', value: 'description' },
      { label: 'วันที่บันทึก', value: 'recorded_at' },
    ];
    const parser = new Parser({ fields, withBOM: true });
    const csv = parser.parse(rows);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=violations.csv');
    res.send(csv);
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถส่งออกข้อมูลได้');
    res.redirect('/data/export');
  } finally {
    if (conn) conn.release();
  }
});

// POST /data/import/registrations
router.post('/import/registrations', isHead, upload.single('file'), verifyCsrf, async (req, res) => {
  if (!req.file) {
    req.flash('error', 'กรุณาเลือกไฟล์');
    return res.redirect('/data/import');
  }

  const results = [];
  let conn;
  try {
    const filePath = req.file.path;
    const fileExt = req.file.originalname.split('.').pop().toLowerCase();

    if (fileExt === 'csv') {
      await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csvParser())
          .on('data', (data) => results.push(data))
          .on('end', resolve)
          .on('error', reject);
      });
    } else if (fileExt === 'xlsx' || fileExt === 'xls') {
      const workbook = xlsx.readFile(filePath, { sheetRows: MAX_IMPORT_ROWS + 1 });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = xlsx.utils.sheet_to_json(sheet);
      results.push(...data);
    } else {
      upload.cleanupUploadedFiles(req);
      req.flash('error', 'รองรับเฉพาะไฟล์ .csv, .xlsx และ .xls เท่านั้น');
      return res.redirect('/data/import');
    }

    if (results.length > MAX_IMPORT_ROWS) {
      upload.cleanupUploadedFiles(req);
      req.flash('error', `นำเข้าได้สูงสุด ${MAX_IMPORT_ROWS} รายการต่อครั้ง`);
      return res.redirect('/data/import');
    }

    conn = await pool.getConnection();
    let imported = 0;
    let skipped = 0;

    for (const row of results) {
      try {
        await conn.query(
          `INSERT INTO registrations (user_type, id_number, first_name, last_name, phone, license_plate, province, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
          [
            row['ประเภท'] || row.user_type || 'student',
            row['รหัส'] || row.id_number,
            row['ชื่อ'] || row.first_name,
            row['นามสกุล'] || row.last_name,
            row['โทรศัพท์'] || row.phone || '',
            row['ป้ายทะเบียน'] || row.license_plate,
            row['จังหวัด'] || row.province || '',
          ]
        );
        imported++;
      } catch (e) {
        skipped++;
      }
    }

    // Cleanup temp file
    upload.cleanupUploadedFiles(req);

    req.flash('success', `นำเข้าสำเร็จ ${imported} รายการ, ข้าม ${skipped} รายการ (อาจเป็นข้อมูลซ้ำ)`);
  } catch (err) {
    console.error(err);
    upload.cleanupUploadedFiles(req);
    req.flash('error', 'เกิดข้อผิดพลาดในการนำเข้าข้อมูล. โปรดตรวจสอบรูปแบบไฟล์');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/data/import');
});

module.exports = router;
