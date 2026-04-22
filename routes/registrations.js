const router = require('express').Router();
const pool = require('../config/database');
const upload = require('../middleware/upload');
const { isAuthenticated, isHead } = require('../middleware/auth');
const { generateHash, compareHashes } = require('../utils/imageHash');

router.use(isAuthenticated);

// GET /registrations
router.get('/', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const { search, type, status, page = 1 } = req.query;
    const limit = 20;
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    const params = [];

    if (search) {
      // Normalize: trim and collapse multiple spaces for reliable matching
      const searchTrimmed = search.trim().replace(/\s+/g, ' ');
      const s = `%${searchTrimmed}%`;
      // Also search by combined full name (first_name + space + last_name)
      const sName = `%${searchTrimmed}%`;
      where += ` AND (
        id_number LIKE ? OR
        first_name LIKE ? OR
        last_name LIKE ? OR
        CONCAT(first_name, ' ', last_name) LIKE ? OR
        license_plate LIKE ? OR
        REPLACE(license_plate, ' ', '') LIKE ? OR
        phone LIKE ?
      )`;
      const sNoSpace = `%${searchTrimmed.replace(/\s+/g, '')}%`;
      params.push(s, s, s, sName, s, sNoSpace, s);
    }
    if (type) { where += ' AND user_type = ?'; params.push(type); }
    if (status) { where += ' AND status = ?'; params.push(status); }

    const [countResult] = await conn.query(`SELECT COUNT(*) as cnt FROM registrations ${where}`, params);
    const total = parseInt(countResult.cnt);
    const totalPages = Math.ceil(total / limit);

    const rows = await conn.query(
      `SELECT id, id_number, user_type, first_name, last_name, phone, license_plate, province, status, registered_at
       FROM registrations ${where} ORDER BY registered_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Pick up image search results from session (set by POST /search)
    const imageSearchResults = req.session.imageSearchResults || null;
    if (req.session.imageSearchResults) delete req.session.imageSearchResults;

    res.render('registrations/index', {
      title: 'จัดการทะเบียน - BU MotoSpace',
      registrations: rows,
      total,
      totalPages,
      currentPage: parseInt(page),
      search: search || '',
      type: type || '',
      status: status || '',
      imageSearchResults,
    });
  } catch (err) {
    console.error('GET /registrations error:', err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลได้: ' + err.message);
    // Render page with empty data instead of redirecting
    return res.render('registrations/index', {
      title: 'จัดการทะเบียน - BU MotoSpace',
      registrations: [],
      total: 0,
      totalPages: 0,
      currentPage: 1,
      search: req.query.search || '',
      type: req.query.type || '',
      status: req.query.status || '',
      imageSearchResults: null,
    });
  } finally {
    if (conn) conn.release();
  }
});

// POST /registrations/search — Process image search (called from modal)
router.post('/search', upload.single('search_image'), async (req, res) => {
  let conn;
  try {
    if (!req.file) {
      req.flash('error', 'กรุณาอัพโหลดภาพ');
      return res.redirect('/registrations');
    }

    const searchHash = await generateHash(req.file.path);
    if (!searchHash) {
      req.flash('error', 'ไม่สามารถประมวลผลภาพได้');
      return res.redirect('/registrations');
    }

    conn = await pool.getConnection();
    const hashes = await conn.query(
      `SELECT ih.*, r.id as reg_id, r.first_name, r.last_name, r.license_plate, r.id_number, r.user_type, r.phone, r.motorcycle_photo, r.plate_photo
       FROM image_hashes ih
       JOIN registrations r ON ih.registration_id = r.id`
    );

    const results = [];
    for (const h of hashes) {
      const similarity = 1 - compareHashes(searchHash, h.phash);
      if (similarity > 0.7) {  // 70% match threshold
        results.push({
          ...h,
          similarity: Math.round(similarity * 100),
        });
      }
    }
    results.sort((a, b) => b.similarity - a.similarity);

    // Redirect to registrations list with search results in flash or session
    req.session.imageSearchResults = {
      results,
      searchImage: '/uploads/temp/' + req.file.filename,
    };
    if (req.headers.referer && req.headers.referer.includes('/violations')) {
      return res.redirect('/violations?imageSearch=1');
    }
    res.redirect('/registrations?imageSearch=1');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
    if (req.headers.referer && req.headers.referer.includes('/violations')) {
      return res.redirect('/violations');
    }
    res.redirect('/registrations');
  } finally {
    if (conn) conn.release();
  }
});

// GET /registrations/api/search — AJAX JSON search (for live search / autocomplete)
router.get('/api/search', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const { q } = req.query;
    if (!q || !q.trim()) return res.json([]);

    const searchTrimmed = q.trim().replace(/\s+/g, ' ');
    const s = `%${searchTrimmed}%`;
    const sNoSpace = `%${searchTrimmed.replace(/\s+/g, '')}%`;

    const rows = await conn.query(
      `SELECT id, id_number, user_type, first_name, last_name, phone, license_plate, province, status
       FROM registrations
       WHERE (
         id_number LIKE ? OR
         first_name LIKE ? OR
         last_name LIKE ? OR
         CONCAT(first_name, ' ', last_name) LIKE ? OR
         license_plate LIKE ? OR
         REPLACE(license_plate, ' ', '') LIKE ? OR
         phone LIKE ?
       )
       ORDER BY registered_at DESC LIMIT 10`,
      [s, s, s, s, s, sNoSpace, s]
    );
    return res.json(rows);
  } catch (err) {
    console.error('AJAX search error:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// GET /registrations/:id

router.get('/:id', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [reg] = await conn.query('SELECT * FROM registrations WHERE id = ?', [req.params.id]);
    if (!reg) {
      req.flash('error', 'ไม่พบข้อมูล');
      return res.redirect('/registrations');
    }

    const violations = await conn.query(
      `SELECT v.*, ru.rule_name, ru.max_violations, 
              a.full_name as recorded_by_name,
              rpa.full_name as reported_by_name
       FROM violations v
       JOIN rules ru ON v.rule_id = ru.id
       JOIN admins a ON v.recorded_by = a.id
       LEFT JOIN violation_reports vr ON vr.violation_id = v.id
       LEFT JOIN admins rpa ON vr.reported_by = rpa.id
       WHERE v.registration_id = ?
       ORDER BY v.recorded_at DESC`,
      [req.params.id]
    );

    // Count violations per rule
    const violationCounts = await conn.query(
      `SELECT v.rule_id, ru.rule_name, ru.max_violations, COUNT(*) as cnt
       FROM violations v JOIN rules ru ON v.rule_id = ru.id
       WHERE v.registration_id = ?
       GROUP BY v.rule_id`,
      [req.params.id]
    );

    res.render('registrations/detail', {
      title: `${reg.first_name} ${reg.last_name} - BU MotoSpace`,
      reg,
      violations,
      violationCounts,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลได้');
    res.redirect('/registrations');
  } finally {
    if (conn) conn.release();
  }
});

// POST /registrations/:id/approve
router.post('/:id/approve', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(
      'UPDATE registrations SET status = ?, approved_by = ?, approved_at = NOW() WHERE id = ?',
      ['approved', req.session.admin.id, req.params.id]
    );
    req.flash('success', 'อนุมัติเรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/registrations/' + req.params.id);
});

// POST /registrations/:id/reject
router.post('/:id/reject', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(
      'UPDATE registrations SET status = ?, notes = ? WHERE id = ?',
      ['rejected', req.body.notes || '', req.params.id]
    );
    req.flash('success', 'ปฏิเสธเรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/registrations/' + req.params.id);
});

// GET /registrations/:id/edit
router.get('/:id/edit', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [reg] = await conn.query('SELECT * FROM registrations WHERE id = ?', [req.params.id]);
    if (!reg) {
      req.flash('error', 'ไม่พบข้อมูล');
      return res.redirect('/registrations');
    }
    res.render('registrations/edit', {
      title: `แก้ไข ${reg.first_name} ${reg.last_name} - BU MotoSpace`,
      reg,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลได้');
    res.redirect('/registrations');
  } finally {
    if (conn) conn.release();
  }
});

// POST /registrations/:id/edit
router.post('/:id/edit', isHead, upload.fields([
  { name: 'motorcycle_photo', maxCount: 1 },
  { name: 'plate_photo', maxCount: 1 },
  { name: 'id_card_photo', maxCount: 1 },
]), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const { user_type, id_number, first_name, last_name, phone, license_plate, province, status } = req.body;

    // Build update query
    let sql = `UPDATE registrations SET user_type = ?, id_number = ?, first_name = ?, last_name = ?, phone = ?, license_plate = ?, province = ?, status = ?`;
    const params = [user_type, id_number, first_name, last_name, phone || null, license_plate, province, status];

    // Handle optional photo uploads
    if (req.files && req.files.motorcycle_photo) {
      sql += ', motorcycle_photo = ?';
      params.push('/uploads/motorcycles/' + req.files.motorcycle_photo[0].filename);
    }
    if (req.files && req.files.plate_photo) {
      sql += ', plate_photo = ?';
      params.push('/uploads/plates/' + req.files.plate_photo[0].filename);
    }
    if (req.files && req.files.id_card_photo) {
      sql += ', id_card_photo = ?';
      params.push('/uploads/id-cards/' + req.files.id_card_photo[0].filename);
    }

    // If status changed to approved, set approved fields
    if (status === 'approved') {
      sql += ', approved_by = ?, approved_at = NOW()';
      params.push(req.session.admin.id);
    }

    sql += ' WHERE id = ?';
    params.push(req.params.id);

    await conn.query(sql, params);
    req.flash('success', 'แก้ไขข้อมูลเรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาดในการแก้ไขข้อมูล');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/registrations/' + req.params.id);
});

// POST /registrations/:id/delete
router.post('/:id/delete', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query('DELETE FROM registrations WHERE id = ?', [req.params.id]);
    req.flash('success', 'ลบข้อมูลเรียบร้อยแล้ว');
  } catch (err) {
    console.error(err);
    req.flash('error', 'เกิดข้อผิดพลาด');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/registrations');
});

module.exports = router;
