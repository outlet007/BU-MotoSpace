const router = require('express').Router();
const pool = require('../config/database');
const { requireRole } = require('../middleware/auth');

router.use(requireRole('head', 'superadmin'));

// Helper: CSV builder with UTF-8 BOM
function buildCSV(fields, data) {
  const BOM = '\uFEFF';
  const header = fields.map(f => `"${f.label}"`).join(',');
  const rows = data.map(item =>
    fields.map(f => {
      let v = item[f.key];
      if (v == null) v = '';
      if (v instanceof Date) v = v.toLocaleString('th-TH');
      return `"${String(v).replace(/"/g, '""')}"`;
    }).join(',')
  );
  return BOM + header + '\n' + rows.join('\n');
}

// Report type definitions
const REPORT_TYPES = {
  reg_all:       { label: 'ทะเบียนรถทั้งหมด', icon: 'clipboard-list' },
  reg_student:   { label: 'ทะเบียนรถนักศึกษา', icon: 'graduation-cap' },
  reg_staff:     { label: 'ทะเบียนรถบุคลากร', icon: 'briefcase' },
  violations:    { label: 'บันทึกการกระทำผิดกฎ', icon: 'shield-alert' },
  summary:       { label: 'สรุปภาพรวมระบบ', icon: 'pie-chart' }
};

// Helper: build query + fields for a report type
async function fetchReport(conn, type, startDate, endDate) {
  let dateFilter = '';
  let params = [];

  if (startDate && endDate) {
    // Use range comparison instead of DATE() to leverage indexes
    const col = type === 'violations' ? 'v.recorded_at' : 'registered_at';
    dateFilter = ` AND ${col} >= ? AND ${col} < DATE_ADD(?, INTERVAL 1 DAY) `;
    params = [startDate, endDate];
  }

  if (type === 'reg_all' || type === 'reg_student' || type === 'reg_staff') {
    let typeFilter = '';
    if (type === 'reg_student') { typeFilter = " AND user_type = 'student' "; }
    if (type === 'reg_staff')   { typeFilter = " AND user_type = 'staff' "; }

    const rows = await conn.query(
      `SELECT id_number, user_type, first_name, last_name, phone, license_plate, province, status, registered_at
       FROM registrations WHERE 1=1 ${dateFilter} ${typeFilter} ORDER BY registered_at DESC`, params
    );

    const fields = [
      { label: 'รหัสประจำตัว', key: 'id_number' },
      { label: 'ประเภท', key: 'user_type_label' },
      { label: 'ชื่อ', key: 'first_name' },
      { label: 'นามสกุล', key: 'last_name' },
      { label: 'เบอร์โทร', key: 'phone' },
      { label: 'ป้ายทะเบียน', key: 'license_plate' },
      { label: 'จังหวัด', key: 'province' },
      { label: 'สถานะ', key: 'status_label' },
      { label: 'วันที่ลงทะเบียน', key: 'registered_at' }
    ];

    rows.forEach(r => {
      r.user_type_label = r.user_type === 'student' ? 'นักศึกษา' : 'บุคลากร';
      r.status_label = r.status === 'approved' ? 'อนุมัติ' : r.status === 'pending' ? 'รอดำเนินการ' : 'ปฏิเสธ';
    });

    return { fields, rows };

  } else if (type === 'violations') {
    const rows = await conn.query(
      `SELECT r.id_number, r.user_type, r.first_name, r.last_name, r.license_plate, ru.rule_name, v.description, v.recorded_at
       FROM violations v
       JOIN registrations r ON v.registration_id = r.id
       JOIN rules ru ON v.rule_id = ru.id
       WHERE 1=1 ${dateFilter} ORDER BY v.recorded_at DESC`, params
    );

    const fields = [
      { label: 'รหัสประจำตัว', key: 'id_number' },
      { label: 'ประเภท', key: 'user_type_label' },
      { label: 'ชื่อ-นามสกุล', key: 'full_name' },
      { label: 'ป้ายทะเบียน', key: 'license_plate' },
      { label: 'กฎที่ฝ่าฝืน', key: 'rule_name' },
      { label: 'รายละเอียด', key: 'description' },
      { label: 'วันที่กระทำผิด', key: 'recorded_at' }
    ];

    rows.forEach(r => {
      r.user_type_label = r.user_type === 'student' ? 'นักศึกษา' : 'บุคลากร';
      r.full_name = r.first_name + ' ' + r.last_name;
    });

    return { fields, rows };

  } else if (type === 'summary') {
    const regCounts = await conn.query(
      `SELECT user_type, status, COUNT(*) as cnt FROM registrations WHERE 1=1 ${dateFilter} GROUP BY user_type, status`, params
    );
    const vioCounts = await conn.query(
      `SELECT ru.rule_name, COUNT(v.id) as cnt FROM violations v JOIN rules ru ON v.rule_id = ru.id WHERE 1=1 ${dateFilter.replace('registered_at', 'v.recorded_at')} GROUP BY ru.id, ru.rule_name ORDER BY cnt DESC`, params
    );
    const topProv = await conn.query(
      `SELECT province, COUNT(*) as cnt FROM registrations WHERE status='approved' ${dateFilter} GROUP BY province ORDER BY cnt DESC LIMIT 5`, params
    );
    return { isSummary: true, regCounts, vioCounts, topProv };
  }

  return { fields: [], rows: [] };
}

// ★★★ IMPORTANT: /export route MUST be defined BEFORE the / route ★★★
// GET /reports/export
router.get('/export', async (req, res) => {
  const { report_type, start_date, end_date } = req.query;
  
  if (!report_type || !REPORT_TYPES[report_type] || report_type === 'summary') {
    req.flash('error', 'ประเภทรายงานไม่ถูกต้อง');
    return res.redirect('/reports');
  }

  let conn;
  try {
    conn = await pool.getConnection();
    const { fields, rows } = await fetchReport(conn, report_type, start_date, end_date);
    const csv = buildCSV(fields, rows);
    
    // Use ASCII-safe filename for Content-Disposition + UTF-8 filename* for modern browsers
    const safeFilename = 'report_' + report_type + '.csv';
    const thaiFilename = REPORT_TYPES[report_type].label + '.csv';
    
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 
      `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(thaiFilename)}`
    );
    
    return res.send(Buffer.from(csv, 'utf-8'));
  } catch (err) {
    console.error('Export Error:', err);
    req.flash('error', 'เกิดข้อผิดพลาดในการส่งออก CSV');
    return res.redirect('/reports');
  } finally {
    if (conn) conn.release();
  }
});

// GET /reports
router.get('/', async (req, res) => {
  const { report_type, start_date, end_date } = req.query;
  const searched = !!report_type;
  let reportData = null;

  if (searched) {
    let conn;
    try {
      conn = await pool.getConnection();
      reportData = await fetchReport(conn, report_type, start_date, end_date);
    } catch (err) {
      console.error(err);
      req.flash('error', 'ไม่สามารถโหลดข้อมูลรายงานได้');
    } finally {
      if (conn) conn.release();
    }
  }

  res.render('reports/index', {
    title: 'รายงาน - BU MotoSpace',
    reportTypes: REPORT_TYPES,
    selectedType: report_type || '',
    start_date: start_date || '',
    end_date: end_date || '',
    searched,
    reportData,
    selectedTypeLabel: report_type ? (REPORT_TYPES[report_type]?.label || '') : '',
    selectedTypeIcon: report_type ? (REPORT_TYPES[report_type]?.icon || '') : ''
  });
});

module.exports = router;
