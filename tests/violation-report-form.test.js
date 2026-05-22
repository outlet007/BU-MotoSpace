const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function assertRequiredLabel(template, labelText) {
  const escapedLabel = labelText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  assert.match(
    template,
    new RegExp(`<label class="label">${escapedLabel}\\s*<span class="text-red-500">\\*</span>\\s*</label>`),
    `${labelText} label should show a red required asterisk`
  );
}

test('violation report form requires rule, details, and evidence before submission', () => {
  const template = readProjectFile('views/violations/create.ejs');

  assert.match(
    template,
    /<select[^>]*name="rule_id"[^>]*required/s,
    'rule select should be required'
  );
  assert.match(
    template,
    /<textarea[^>]*name="description"[^>]*required/s,
    'description textarea should be required'
  );
  assert.match(
    template,
    /<input[^>]*name="evidence_photo"[^>]*required/s,
    'evidence photo upload should be required'
  );
  assertRequiredLabel(template, 'กฎที่ฝ่าฝืน');
  assertRequiredLabel(template, 'รายละเอียด');
  assertRequiredLabel(template, 'หลักฐาน (ภาพถ่าย)');
});

test('violation report submit button uses concise label', () => {
  const template = readProjectFile('views/violations/create.ejs');

  assert.match(template, /ส่งแจ้งการกระทำผิด/);
  assert.doesNotMatch(template, /ส่งแจ้งการกระทำผิด\s*\(รอการตรวจสอบ\)/);
});

test('POST /violations rejects missing details or evidence on the server', () => {
  const route = readProjectFile('routes/violations.js');

  assert.match(
    route,
    /const description = \(req\.body\.description \|\| ''\)\.trim\(\);/,
    'route should trim description before validation and persistence'
  );
  assert.match(
    route,
    /if \(!description\)/,
    'route should reject empty description'
  );
  assert.match(
    route,
    /if \(!req\.file\)/,
    'route should reject missing evidence photo'
  );
  assert.match(
    route,
    /\[registrationId, ruleId, description, evidencePhoto, req\.session\.admin\.id\]/,
    'route should persist validated description directly'
  );
});
