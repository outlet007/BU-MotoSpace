const router = require('express').Router();
const pool = require('../config/database');
const { isAuthenticated, isHead } = require('../middleware/auth');

router.use(isAuthenticated, isHead);

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
      const [summonsRow] = await conn.query(
        `SELECT COUNT(*) AS cnt
         FROM (
           SELECT owner_key
           FROM (
             SELECT
               CONCAT(r.user_type, ':', r.id_number) AS owner_key,
               COALESCE(ru.violation_type_id, -ru.id) AS violation_group_id,
               COUNT(v.id) AS type_violations,
               COALESCE(MAX(vt.max_violations), MAX(ru.max_violations), ${DEFAULT_SUMMONS_THRESHOLD}) AS required_violations
             FROM registrations r
             JOIN violations v ON v.registration_id = r.id
             JOIN rules ru ON v.rule_id = ru.id
             LEFT JOIN violation_types vt ON ru.violation_type_id = vt.id
             LEFT JOIN (
               SELECT sr.user_type, sr.id_number, sa.violation_type_id, MAX(sa.created_at) AS latest_reset_at
               FROM summons_appointments sa
               JOIN registrations sr ON sa.registration_id = sr.id
               WHERE sa.violation_type_id IS NOT NULL
               GROUP BY sr.user_type, sr.id_number, sa.violation_type_id
             ) sa_type ON sa_type.user_type = r.user_type
                       AND sa_type.id_number = r.id_number
                       AND sa_type.violation_type_id = ru.violation_type_id
             LEFT JOIN (
               SELECT sr.user_type, sr.id_number, MAX(sa.created_at) AS latest_reset_at
               FROM summons_appointments sa
               JOIN registrations sr ON sa.registration_id = sr.id
               WHERE sa.violation_type_id IS NULL
               GROUP BY sr.user_type, sr.id_number
             ) sa_global ON sa_global.user_type = r.user_type
                         AND sa_global.id_number = r.id_number
             WHERE v.deleted_at IS NULL
               AND r.deleted_at IS NULL
               AND v.recorded_at > COALESCE(
               GREATEST(
                 COALESCE(sa_type.latest_reset_at, '1000-01-01'),
                 COALESCE(sa_global.latest_reset_at, '1000-01-01')
               ),
               '1000-01-01 00:00:00'
             )
             GROUP BY r.user_type, r.id_number, COALESCE(ru.violation_type_id, -ru.id)
             HAVING type_violations >= required_violations
           ) qualified_by_type
           GROUP BY owner_key
         ) candidates`
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
                r.first_name, r.last_name, r.license_plate, r.province, r.user_type,
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
