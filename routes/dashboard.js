const router = require('express').Router();
const pool = require('../config/database');
const { isAuthenticated, isHead } = require('../middleware/auth');

router.use(isAuthenticated, isHead);

const SUMMONS_THRESHOLD_KEY = 'summons_total_threshold';
const DEFAULT_SUMMONS_THRESHOLD = 3;

// GET /dashboard
router.get('/', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();

    // Statistics
    const [totalRegs] = await conn.query('SELECT COUNT(*) as cnt FROM registrations');
    const [pendingRegs] = await conn.query("SELECT COUNT(*) as cnt FROM registrations WHERE status='pending'");
    const [approvedRegs] = await conn.query("SELECT COUNT(*) as cnt FROM registrations WHERE status='approved'");
    const [totalViolations] = await conn.query('SELECT COUNT(*) as cnt FROM violations');
    const [studentCount] = await conn.query("SELECT COUNT(*) as cnt FROM registrations WHERE user_type='student'");
    const [staffCount] = await conn.query("SELECT COUNT(*) as cnt FROM registrations WHERE user_type='staff'");

    // นับจำนวนรายการรอตรวจสอบจาก violation_reports (status='pending')
    let pendingReportsCount = 0;
    try {
      const [pendingRptRow] = await conn.query("SELECT COUNT(*) as cnt FROM violation_reports WHERE status='pending'");
      pendingReportsCount = parseInt(pendingRptRow.cnt) || 0;
    } catch(e) { /* ตารางอาจยังไม่มี */ }

    let summonsCandidatesCount = 0;
    try {
      await conn.query(`
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
      const [thresholdRow] = await conn.query(
        'SELECT setting_value FROM app_settings WHERE setting_key = ?',
        [SUMMONS_THRESHOLD_KEY]
      ).catch(() => [null]);
      const thresholdValue = parseInt(thresholdRow && thresholdRow.setting_value, 10);
      const threshold = Number.isFinite(thresholdValue) && thresholdValue > 0 ? thresholdValue : DEFAULT_SUMMONS_THRESHOLD;
      const [summonsRow] = await conn.query(
        `SELECT COUNT(*) AS cnt
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
        [threshold]
      );
      summonsCandidatesCount = parseInt(summonsRow.cnt) || 0;
    } catch(e) {
      summonsCandidatesCount = 0;
    }

    // การลงทะเบียนใหม่ — เฉพาะที่ยังรอการอนุมัติ (pending)
    const newPendingRegs = await conn.query(
      `SELECT * FROM registrations WHERE status = 'pending' ORDER BY registered_at DESC LIMIT 10`
    );

    // ตรวจสอบการกระทำผิดกฎ — รายการรอตรวจสอบจาก violation_reports
    let pendingViolationReports = [];
    try {
      pendingViolationReports = await conn.query(
        `SELECT vr.id, vr.reported_at, vr.description, vr.status,
                r.first_name, r.last_name, r.license_plate, r.user_type,
                ru.rule_name,
                a.full_name AS reported_by_name
         FROM violation_reports vr
         JOIN registrations r ON vr.registration_id = r.id
         JOIN rules ru ON vr.rule_id = ru.id
         LEFT JOIN admins a ON vr.reported_by = a.id
         WHERE vr.status = 'pending'
         ORDER BY vr.reported_at DESC
         LIMIT 10`
      );
    } catch (e) {
      // ตารางอาจยังไม่มี — ข้ามไป
      pendingViolationReports = [];
    }

    // Monthly registrations (last 6 months)
    const monthlyData = await conn.query(
      `SELECT DATE_FORMAT(registered_at, '%Y-%m') as month, COUNT(*) as cnt
       FROM registrations
       WHERE registered_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
       GROUP BY month ORDER BY month`
    );

    // Top violated rules
    const topRules = await conn.query(
      `SELECT ru.rule_name, COUNT(v.id) as cnt
       FROM violations v JOIN rules ru ON v.rule_id = ru.id
       GROUP BY v.rule_id ORDER BY cnt DESC LIMIT 5`
    );

    res.render('dashboard', {
      title: 'แดชบอร์ด - BU MotoSpace',
      stats: {
        total: parseInt(totalRegs.cnt),
        pending: parseInt(pendingRegs.cnt),
        approved: parseInt(approvedRegs.cnt),
        violations: parseInt(totalViolations.cnt),
        pendingReports: pendingReportsCount,
        summonsCandidates: summonsCandidatesCount,
        students: parseInt(studentCount.cnt),
        staff: parseInt(staffCount.cnt),
      },
      newPendingRegs,
      pendingViolationReports,
      monthlyData,
      topRules,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูล Dashboard ได้');
    res.render('dashboard', {
      title: 'แดชบอร์ด - BU MotoSpace',
      stats: { total: 0, pending: 0, approved: 0, violations: 0, pendingReports: 0, summonsCandidates: 0, students: 0, staff: 0 },
      newPendingRegs: [],
      pendingViolationReports: [],
      monthlyData: [],
      topRules: [],
    });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
