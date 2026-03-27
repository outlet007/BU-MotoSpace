const router = require('express').Router();
const pool = require('../config/database');
const { isAuthenticated } = require('../middleware/auth');

router.use(isAuthenticated);

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

    // Recent registrations
    const recentRegs = await conn.query(
      'SELECT * FROM registrations ORDER BY registered_at DESC LIMIT 10'
    );

    // Recent violations
    const recentViolations = await conn.query(
      `SELECT v.*, r.first_name, r.last_name, r.license_plate, r.user_type, ru.rule_name
       FROM violations v
       JOIN registrations r ON v.registration_id = r.id
       JOIN rules ru ON v.rule_id = ru.id
       ORDER BY v.recorded_at DESC LIMIT 10`
    );

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
        students: parseInt(studentCount.cnt),
        staff: parseInt(staffCount.cnt),
      },
      recentRegs,
      recentViolations,
      monthlyData,
      topRules,
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'ไม่สามารถโหลดข้อมูล Dashboard ได้');
    res.render('dashboard', {
      title: 'แดชบอร์ด - BU MotoSpace',
      stats: { total: 0, pending: 0, approved: 0, violations: 0, students: 0, staff: 0 },
      recentRegs: [],
      recentViolations: [],
      monthlyData: [],
      topRules: [],
    });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
