const router = require('express').Router();
const pool = require('../config/database');
const { isAuthenticated, isHead } = require('../middleware/auth');

router.use(isAuthenticated, isHead);

const DEFAULT_MAX_VIOLATIONS = 3;
const VALID_TABS = new Set(['rules', 'types', 'penalties']);

function positiveInt(value, fallback = DEFAULT_MAX_VIOLATIONS) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeTypeCode(value) {
  return (value || '').trim().toUpperCase().replace(/^IR-/, '').replace(/[^A-Z0-9]/g, '');
}

function isValidTypeCode(value) {
  return /^[A-Z0-9]{2,10}$/.test(value);
}

function suggestViolationTypeCode(typeName) {
  const name = String(typeName || '').toLowerCase();
  if (name.includes('เล็กน้อย') || name.includes('minor') || name.includes('min')) return 'MIN';
  if (name.includes('ปานกลาง') || name.includes('major') || name.includes('maj')) return 'MAJ';
  if (name.includes('ร้ายแรง') || name.includes('critical') || name.includes('cri')) return 'CRI';
  return null;
}

function activeTabFrom(req, fallback = 'rules') {
  return VALID_TABS.has(req.query.tab) ? req.query.tab : fallback;
}

async function ensureRulesColumn(conn, columnName, definition) {
  const [column] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'rules'
       AND COLUMN_NAME = ?`,
    [columnName]
  );

  if (parseInt(column.cnt, 10) === 0) {
    await conn.query(`ALTER TABLE rules ADD COLUMN ${columnName} ${definition}`);
  }
}

async function ensureRulesIndex(conn, indexName, columnName) {
  const [index] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'rules'
       AND INDEX_NAME = ?`,
    [indexName]
  );

  if (parseInt(index.cnt, 10) === 0) {
    await conn.query(`ALTER TABLE rules ADD INDEX ${indexName} (${columnName})`);
  }
}

async function ensureViolationTypeColumn(conn, columnName, definition) {
  const [column] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'violation_types'
       AND COLUMN_NAME = ?`,
    [columnName]
  );

  if (parseInt(column.cnt, 10) === 0) {
    await conn.query(`ALTER TABLE violation_types ADD COLUMN ${columnName} ${definition}`);
  }
}

async function ensureViolationTypeIndex(conn, indexName, columnName, unique = false) {
  const [index] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'violation_types'
       AND INDEX_NAME = ?`,
    [indexName]
  );

  if (parseInt(index.cnt, 10) === 0) {
    await conn.query(`ALTER TABLE violation_types ADD ${unique ? 'UNIQUE ' : ''}INDEX ${indexName} (${columnName})`);
  }
}

async function ensureViolationTypeSchema(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS violation_types (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type_name VARCHAR(200) NOT NULL UNIQUE,
      type_code VARCHAR(20) DEFAULT NULL,
      max_violations INT NOT NULL DEFAULT 3,
      is_active BOOLEAN DEFAULT TRUE,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_violation_type_code (type_code),
      FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  await ensureViolationTypeColumn(conn, 'type_code', 'VARCHAR(20) DEFAULT NULL AFTER type_name');
  await ensureViolationTypeIndex(conn, 'uq_violation_type_code', 'type_code', true);
  await ensureRulesColumn(conn, 'violation_type_id', 'INT DEFAULT NULL AFTER description');
  await ensureRulesIndex(conn, 'idx_rules_violation_type', 'violation_type_id');
  await seedViolationTypesFromRules(conn);
  await seedMissingViolationTypeCodes(conn);
}

async function seedViolationTypesFromRules(conn) {
  const [typeCount] = await conn.query('SELECT COUNT(*) AS cnt FROM violation_types');

  if (parseInt(typeCount.cnt, 10) === 0) {
    const maxRows = await conn.query(
      'SELECT DISTINCT max_violations FROM rules WHERE max_violations IS NOT NULL ORDER BY max_violations ASC'
    );
    const seedRows = maxRows.length > 0 ? maxRows : [{ max_violations: DEFAULT_MAX_VIOLATIONS }];

    for (const row of seedRows) {
      const maxViolations = positiveInt(row.max_violations);
      await conn.query(
        `INSERT INTO violation_types (type_name, max_violations, is_active)
         VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE max_violations = VALUES(max_violations)`,
        [`ประเภทความผิด ${maxViolations} ครั้ง`, maxViolations]
      );
    }
  }

  const unassignedRows = await conn.query(
    'SELECT COUNT(*) AS cnt FROM rules WHERE violation_type_id IS NULL'
  );
  const hasUnassignedRules = unassignedRows[0] && parseInt(unassignedRows[0].cnt, 10) > 0;

  if (!hasUnassignedRules) return;

  const typeRows = await conn.query(
    'SELECT id, max_violations FROM violation_types ORDER BY is_active DESC, id ASC'
  );

  for (const type of typeRows) {
    await conn.query(
      `UPDATE rules
       SET violation_type_id = ?
       WHERE violation_type_id IS NULL AND max_violations = ?`,
      [type.id, type.max_violations]
    );
  }

  if (typeRows.length > 0) {
    await conn.query(
      `UPDATE rules
       SET violation_type_id = ?
       WHERE violation_type_id IS NULL`,
      [typeRows[0].id]
    );
  }
}

async function seedMissingViolationTypeCodes(conn) {
  const existingRows = await conn.query(
    `SELECT UPPER(type_code) AS type_code
     FROM violation_types
     WHERE type_code IS NOT NULL AND TRIM(type_code) <> ''`
  );
  const usedCodes = new Set(existingRows.map(row => row.type_code));

  const missingRows = await conn.query(
    `SELECT id, type_name
     FROM violation_types
     WHERE type_code IS NULL OR TRIM(type_code) = ''`
  );

  for (const row of missingRows) {
    const code = suggestViolationTypeCode(row.type_name);
    if (!code || usedCodes.has(code)) continue;
    await conn.query('UPDATE violation_types SET type_code = ? WHERE id = ?', [code, row.id]);
    usedCodes.add(code);
  }
}

async function ensurePenaltyTypeSchema(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS penalty_types (
      id INT AUTO_INCREMENT PRIMARY KEY,
      penalty_name VARCHAR(200) NOT NULL UNIQUE,
      description TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  await ensureRulesColumn(conn, 'violation_type_id', 'INT DEFAULT NULL AFTER description');
  await ensureRulesIndex(conn, 'idx_rules_violation_type', 'violation_type_id');
  await ensureRulesColumn(conn, 'penalty_type_id', 'INT DEFAULT NULL AFTER violation_type_id');
  await ensureRulesIndex(conn, 'idx_rules_penalty_type', 'penalty_type_id');
  await seedPenaltyTypesFromRules(conn);
}

async function seedPenaltyTypesFromRules(conn) {
  const [penaltyTypeCount] = await conn.query('SELECT COUNT(*) AS cnt FROM penalty_types');

  if (parseInt(penaltyTypeCount.cnt, 10) === 0) {
    const penaltyRows = await conn.query(
      `SELECT DISTINCT TRIM(penalty) AS penalty_name
       FROM rules
       WHERE penalty IS NOT NULL AND TRIM(penalty) <> ''
       ORDER BY TRIM(penalty)`
    );
    const seedRows = penaltyRows.length > 0 ? penaltyRows : [{ penalty_name: 'ตักเตือน' }];

    for (const row of seedRows) {
      const penaltyName = (row.penalty_name || '').trim();
      if (!penaltyName) continue;
      await conn.query(
        `INSERT INTO penalty_types (penalty_name, is_active)
         VALUES (?, 1)
         ON DUPLICATE KEY UPDATE penalty_name = VALUES(penalty_name)`,
        [penaltyName]
      );
    }
  }

  const unassignedRows = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM rules
     WHERE penalty_type_id IS NULL
       AND penalty IS NOT NULL
       AND TRIM(penalty) <> ''`
  );
  const hasUnassignedRules = unassignedRows[0] && parseInt(unassignedRows[0].cnt, 10) > 0;

  if (!hasUnassignedRules) return;

  const penaltyTypes = await conn.query(
    'SELECT id, penalty_name FROM penalty_types ORDER BY is_active DESC, id ASC'
  );

  for (const penaltyType of penaltyTypes) {
    await conn.query(
      `UPDATE rules
       SET penalty_type_id = ?
       WHERE penalty_type_id IS NULL
         AND TRIM(COALESCE(penalty, '')) = ?`,
      [penaltyType.id, penaltyType.penalty_name]
    );
  }
}

async function ensureRuleManagementSchema(conn) {
  await ensureViolationTypeSchema(conn);
  await ensurePenaltyTypeSchema(conn);
}

async function getViolationType(conn, id, options = {}) {
  const typeId = parseInt(id, 10);
  if (!Number.isFinite(typeId) || typeId <= 0) return null;

  const where = options.onlyActive ? 'WHERE id = ? AND is_active = 1' : 'WHERE id = ?';
  const [type] = await conn.query(
    `SELECT id, type_name, type_code, max_violations, is_active FROM violation_types ${where}`,
    [typeId]
  );
  return type || null;
}

async function getPenaltyType(conn, id, options = {}) {
  const typeId = parseInt(id, 10);
  if (!Number.isFinite(typeId) || typeId <= 0) return null;

  const where = options.onlyActive ? 'WHERE id = ? AND is_active = 1' : 'WHERE id = ?';
  const [type] = await conn.query(
    `SELECT id, penalty_name, description, is_active FROM penalty_types ${where}`,
    [typeId]
  );
  return type || null;
}

router.get('/', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureRuleManagementSchema(conn);

    const activeTab = activeTabFrom(req);
    const rules = await conn.query(
      `SELECT r.*,
              vt.type_name,
              vt.max_violations AS type_max_violations,
              vt.is_active AS type_is_active,
              pt.penalty_name,
              pt.is_active AS penalty_type_is_active,
              COALESCE(vt.max_violations, r.max_violations) AS effective_max_violations,
              COALESCE(pt.penalty_name, r.penalty) AS effective_penalty,
              a.full_name AS created_by_name,
              (SELECT COUNT(*) FROM violations v WHERE v.rule_id = r.id) AS violation_count
       FROM rules r
       LEFT JOIN violation_types vt ON r.violation_type_id = vt.id
       LEFT JOIN penalty_types pt ON r.penalty_type_id = pt.id
       LEFT JOIN admins a ON r.created_by = a.id
       ORDER BY r.created_at DESC`
    );

    if (req.query.format === 'json') {
      return res.json(rules.map(r => ({
        id: r.id,
        rule_name: r.rule_name,
        max_violations: r.effective_max_violations
      })));
    }

    const violationTypes = await conn.query(
      `SELECT vt.*,
              a.full_name AS created_by_name,
              (SELECT COUNT(*) FROM rules r WHERE r.violation_type_id = vt.id) AS rule_count
       FROM violation_types vt
       LEFT JOIN admins a ON vt.created_by = a.id
       ORDER BY vt.is_active DESC, vt.created_at DESC`
    );

    const penaltyTypes = await conn.query(
      `SELECT pt.*,
              a.full_name AS created_by_name,
              (SELECT COUNT(*) FROM rules r WHERE r.penalty_type_id = pt.id) AS rule_count
       FROM penalty_types pt
       LEFT JOIN admins a ON pt.created_by = a.id
       ORDER BY pt.is_active DESC, pt.created_at DESC`
    );

    res.render('rules/index', {
      title: 'กฎและข้อบังคับ - BU MotoSpace',
      rules,
      violationTypes,
      penaltyTypes,
      activeTab
    });
  } catch (err) {
    console.error('GET /rules error:', err);
    if (req.query.format === 'json') return res.json([]);
    req.flash('error', 'ไม่สามารถโหลดข้อมูลกฎและข้อบังคับได้');
    res.redirect('/dashboard');
  } finally {
    if (conn) conn.release();
  }
});

router.post('/types', isHead, async (req, res) => {
  const typeName = (req.body.type_name || '').trim();
  const typeCode = normalizeTypeCode(req.body.type_code);
  const maxViolations = positiveInt(req.body.max_violations);
  let conn;

  if (!typeName) {
    req.flash('error', 'กรุณาระบุชื่อประเภทความผิด');
    return res.redirect('/rules?tab=types');
  }

  if (!isValidTypeCode(typeCode)) {
    req.flash('error', 'กรุณาระบุรหัสประเภทความผิดเป็นตัวอักษรอังกฤษ/ตัวเลข 2-10 ตัว เช่น MIN, MAJ, CRI');
    return res.redirect('/rules?tab=types');
  }

  try {
    conn = await pool.getConnection();
    await ensureViolationTypeSchema(conn);
    await conn.query(
      `INSERT INTO violation_types (type_name, type_code, max_violations, created_by)
       VALUES (?, ?, ?, ?)`,
      [typeName, typeCode, maxViolations, req.session.admin.id]
    );
    req.flash('success', 'เพิ่มประเภทความผิดเรียบร้อยแล้ว');
  } catch (err) {
    console.error('POST /rules/types error:', err);
    const message = err.code === 'ER_DUP_ENTRY'
      ? 'ชื่อประเภทความผิดหรือรหัสประเภทความผิดซ้ำกับที่มีอยู่แล้ว'
      : 'ไม่สามารถเพิ่มประเภทความผิดได้: ' + err.message;
    req.flash('error', message);
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/rules?tab=types');
});

router.post('/types/:id/update', isHead, async (req, res) => {
  const typeName = (req.body.type_name || '').trim();
  const typeCode = normalizeTypeCode(req.body.type_code);
  const maxViolations = positiveInt(req.body.max_violations);
  const isActive = req.body.is_active === 'on' ? 1 : 0;
  let conn;

  if (!typeName) {
    req.flash('error', 'กรุณาระบุชื่อประเภทความผิด');
    return res.redirect('/rules?tab=types');
  }

  if (!isValidTypeCode(typeCode)) {
    req.flash('error', 'กรุณาระบุรหัสประเภทความผิดเป็นตัวอักษรอังกฤษ/ตัวเลข 2-10 ตัว เช่น MIN, MAJ, CRI');
    return res.redirect('/rules?tab=types');
  }

  try {
    conn = await pool.getConnection();
    await ensureViolationTypeSchema(conn);
    await conn.query(
      `UPDATE violation_types
       SET type_name = ?, type_code = ?, max_violations = ?, is_active = ?
       WHERE id = ?`,
      [typeName, typeCode, maxViolations, isActive, req.params.id]
    );
    await conn.query(
      `UPDATE rules
       SET max_violations = ?
       WHERE violation_type_id = ?`,
      [maxViolations, req.params.id]
    );
    req.flash('success', 'อัปเดตประเภทความผิดเรียบร้อยแล้ว');
  } catch (err) {
    console.error('POST /rules/types/:id/update error:', err);
    const message = err.code === 'ER_DUP_ENTRY'
      ? 'ชื่อประเภทความผิดหรือรหัสประเภทความผิดซ้ำกับที่มีอยู่แล้ว'
      : 'ไม่สามารถอัปเดตประเภทความผิดได้: ' + err.message;
    req.flash('error', message);
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/rules?tab=types');
});

router.post('/types/:id/delete', isHead, async (req, res) => {
  let conn;

  try {
    conn = await pool.getConnection();
    await ensureViolationTypeSchema(conn);

    const [type] = await conn.query('SELECT id, type_name FROM violation_types WHERE id = ?', [req.params.id]);
    if (!type) {
      req.flash('error', 'ไม่พบประเภทความผิดที่ต้องการลบ');
      return res.redirect('/rules?tab=types');
    }

    const [usage] = await conn.query(
      'SELECT COUNT(*) AS cnt FROM rules WHERE violation_type_id = ?',
      [req.params.id]
    );
    const ruleCount = parseInt(usage.cnt, 10) || 0;

    if (ruleCount > 0) {
      await conn.query('UPDATE violation_types SET is_active = 0 WHERE id = ?', [req.params.id]);
      req.flash('success', `ประเภท "${type.type_name}" ถูกใช้งานอยู่ ${ruleCount} กฎ จึงปิดใช้งานแทนการลบ`);
    } else {
      await conn.query('DELETE FROM violation_types WHERE id = ?', [req.params.id]);
      req.flash('success', `ลบประเภท "${type.type_name}" เรียบร้อยแล้ว`);
    }
  } catch (err) {
    console.error('POST /rules/types/:id/delete error:', err);
    req.flash('error', 'ไม่สามารถลบประเภทความผิดได้: ' + err.message);
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/rules?tab=types');
});

router.post('/penalties', isHead, async (req, res) => {
  const penaltyName = (req.body.penalty_name || '').trim();
  const description = (req.body.description || '').trim() || null;
  let conn;

  if (!penaltyName) {
    req.flash('error', 'กรุณาระบุชื่อประเภทบทลงโทษ');
    return res.redirect('/rules?tab=penalties');
  }

  try {
    conn = await pool.getConnection();
    await ensurePenaltyTypeSchema(conn);
    await conn.query(
      `INSERT INTO penalty_types (penalty_name, description, created_by)
       VALUES (?, ?, ?)`,
      [penaltyName, description, req.session.admin.id]
    );
    req.flash('success', 'เพิ่มประเภทบทลงโทษเรียบร้อยแล้ว');
  } catch (err) {
    console.error('POST /rules/penalties error:', err);
    req.flash('error', 'ไม่สามารถเพิ่มประเภทบทลงโทษได้: ' + err.message);
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/rules?tab=penalties');
});

router.post('/penalties/:id/update', isHead, async (req, res) => {
  const penaltyName = (req.body.penalty_name || '').trim();
  const description = (req.body.description || '').trim() || null;
  const isActive = req.body.is_active === 'on' ? 1 : 0;
  let conn;

  if (!penaltyName) {
    req.flash('error', 'กรุณาระบุชื่อประเภทบทลงโทษ');
    return res.redirect('/rules?tab=penalties');
  }

  try {
    conn = await pool.getConnection();
    await ensurePenaltyTypeSchema(conn);
    await conn.query(
      `UPDATE penalty_types
       SET penalty_name = ?, description = ?, is_active = ?
       WHERE id = ?`,
      [penaltyName, description, isActive, req.params.id]
    );
    await conn.query(
      `UPDATE rules
       SET penalty = ?
       WHERE penalty_type_id = ?`,
      [penaltyName, req.params.id]
    );
    req.flash('success', 'อัปเดตประเภทบทลงโทษเรียบร้อยแล้ว');
  } catch (err) {
    console.error('POST /rules/penalties/:id/update error:', err);
    req.flash('error', 'ไม่สามารถอัปเดตประเภทบทลงโทษได้: ' + err.message);
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/rules?tab=penalties');
});

router.post('/penalties/:id/delete', isHead, async (req, res) => {
  let conn;

  try {
    conn = await pool.getConnection();
    await ensurePenaltyTypeSchema(conn);

    const [type] = await conn.query('SELECT id, penalty_name FROM penalty_types WHERE id = ?', [req.params.id]);
    if (!type) {
      req.flash('error', 'ไม่พบประเภทบทลงโทษที่ต้องการลบ');
      return res.redirect('/rules?tab=penalties');
    }

    const [usage] = await conn.query(
      'SELECT COUNT(*) AS cnt FROM rules WHERE penalty_type_id = ?',
      [req.params.id]
    );
    const ruleCount = parseInt(usage.cnt, 10) || 0;

    if (ruleCount > 0) {
      await conn.query('UPDATE penalty_types SET is_active = 0 WHERE id = ?', [req.params.id]);
      req.flash('success', `ประเภทบทลงโทษ "${type.penalty_name}" ถูกใช้งานอยู่ ${ruleCount} กฎ จึงปิดใช้งานแทนการลบ`);
    } else {
      await conn.query('DELETE FROM penalty_types WHERE id = ?', [req.params.id]);
      req.flash('success', `ลบประเภทบทลงโทษ "${type.penalty_name}" เรียบร้อยแล้ว`);
    }
  } catch (err) {
    console.error('POST /rules/penalties/:id/delete error:', err);
    req.flash('error', 'ไม่สามารถลบประเภทบทลงโทษได้: ' + err.message);
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/rules?tab=penalties');
});

router.post('/', isHead, async (req, res) => {
  const { rule_name, description, violation_type_id, penalty_type_id } = req.body;
  const cleanName = (rule_name || '').trim();

  if (!cleanName) {
    req.flash('error', 'กรุณาระบุชื่อกฎและข้อบังคับ');
    return res.redirect('/rules?tab=rules');
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await ensureRuleManagementSchema(conn);

    const violationType = await getViolationType(conn, violation_type_id, { onlyActive: true });
    if (!violationType) {
      req.flash('error', 'กรุณาเลือกประเภทความผิดที่เปิดใช้งานอยู่');
      return res.redirect('/rules?tab=rules');
    }

    const penaltyType = await getPenaltyType(conn, penalty_type_id, { onlyActive: true });
    if (!penaltyType) {
      req.flash('error', 'กรุณาเลือกประเภทบทลงโทษที่เปิดใช้งานอยู่');
      return res.redirect('/rules?tab=rules');
    }

    await conn.query(
      `INSERT INTO rules
        (rule_name, description, violation_type_id, penalty_type_id, max_violations, penalty, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        cleanName,
        description || null,
        violationType.id,
        penaltyType.id,
        violationType.max_violations,
        penaltyType.penalty_name,
        req.session.admin.id
      ]
    );
    req.flash('success', 'เพิ่มกฎเรียบร้อยแล้ว');
  } catch (err) {
    console.error('POST /rules error:', err);
    req.flash('error', 'เกิดข้อผิดพลาดในการเพิ่มกฎ: ' + err.message);
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/rules?tab=rules');
});

router.post('/:id/update', isHead, async (req, res) => {
  const { rule_name, description, violation_type_id, penalty_type_id, is_active } = req.body;
  const cleanName = (rule_name || '').trim();

  if (!cleanName) {
    req.flash('error', 'กรุณาระบุชื่อกฎและข้อบังคับ');
    return res.redirect('/rules?tab=rules');
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await ensureRuleManagementSchema(conn);

    const violationType = await getViolationType(conn, violation_type_id);
    if (!violationType) {
      req.flash('error', 'กรุณาเลือกประเภทความผิด');
      return res.redirect('/rules?tab=rules');
    }

    const penaltyType = await getPenaltyType(conn, penalty_type_id);
    if (!penaltyType) {
      req.flash('error', 'กรุณาเลือกประเภทบทลงโทษ');
      return res.redirect('/rules?tab=rules');
    }

    await conn.query(
      `UPDATE rules
       SET rule_name = ?,
           description = ?,
           violation_type_id = ?,
           penalty_type_id = ?,
           max_violations = ?,
           penalty = ?,
           is_active = ?
       WHERE id = ?`,
      [
        cleanName,
        description || null,
        violationType.id,
        penaltyType.id,
        violationType.max_violations,
        penaltyType.penalty_name,
        is_active === 'on' ? 1 : 0,
        req.params.id
      ]
    );
    req.flash('success', 'อัปเดตกฎเรียบร้อยแล้ว');
  } catch (err) {
    console.error('POST /rules/:id/update error:', err);
    req.flash('error', 'เกิดข้อผิดพลาดในการอัปเดตกฎ: ' + err.message);
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/rules?tab=rules');
});

router.post('/:id/toggle', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rule] = await conn.query('SELECT id, rule_name, is_active FROM rules WHERE id = ?', [req.params.id]);

    if (!rule) {
      req.flash('error', 'ไม่พบกฎและข้อบังคับที่ต้องการเปลี่ยนสถานะ');
      return res.redirect('/rules?tab=rules');
    }

    const nextStatus = rule.is_active ? 0 : 1;
    await conn.query('UPDATE rules SET is_active = ? WHERE id = ?', [nextStatus, req.params.id]);

    req.flash(
      'success',
      `${nextStatus ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}กฎ "${rule.rule_name}" เรียบร้อยแล้ว`
    );
  } catch (err) {
    console.error('POST /rules/:id/toggle error:', err);
    req.flash('error', 'เกิดข้อผิดพลาดในการเปลี่ยนสถานะกฎ: ' + err.message);
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/rules?tab=rules');
});

router.post('/:id/delete', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query('UPDATE rules SET is_active = 0 WHERE id = ?', [req.params.id]);
    req.flash('success', 'ซ่อนกฎเรียบร้อยแล้ว ประวัติการใช้งานเดิมยังคงอยู่');
  } catch (err) {
    console.error('POST /rules/:id/delete error:', err);
    req.flash('error', 'ไม่สามารถซ่อนกฎได้: ' + err.message);
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/rules?tab=rules');
});

router.post('/:id/destroy', isHead, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rule] = await conn.query('SELECT id, rule_name FROM rules WHERE id = ?', [req.params.id]);

    if (!rule) {
      req.flash('error', 'ไม่พบกฎและข้อบังคับที่ต้องการลบถาวร');
      return res.redirect('/rules?tab=rules');
    }

    await conn.query('DELETE FROM rules WHERE id = ?', [req.params.id]);
    req.flash('success', `ลบกฎ "${rule.rule_name}" ออกจากระบบถาวรเรียบร้อยแล้ว`);
  } catch (err) {
    console.error('POST /rules/:id/destroy error:', err);
    req.flash('error', 'ไม่สามารถลบกฎถาวรได้: ' + err.message);
  } finally {
    if (conn) conn.release();
  }

  res.redirect('/rules?tab=rules');
});

module.exports = router;
