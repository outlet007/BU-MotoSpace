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
    new RegExp(`<label class="label"[^>]*>${escapedLabel}\\s*<span class="text-red-500">\\*</span>\\s*</label>`),
    `${labelText} label should show a red required asterisk`
  );
}

test('violation report edit modal requires rule and details before saving', () => {
  const template = readProjectFile('views/violation-reports/detail.ejs');

  assertRequiredLabel(template, 'กฎที่ฝ่าฝืน');
  assertRequiredLabel(template, 'รายละเอียด');
  assert.match(
    template,
    /<form[^>]*id="edit-form"[^>]*action="\/violation-reports\/<%= r\.id %>\/edit"/s,
    'edit modal form should have a stable id for validation'
  );
  assert.match(
    template,
    /<select[^>]*id="edit-rule-id"[^>]*name="rule_id"[^>]*required/s,
    'edit rule select should be required'
  );
  assert.match(
    template,
    /<textarea[^>]*id="edit-description"[^>]*name="description"[^>]*required/s,
    'edit description textarea should be required'
  );
  assert.match(
    template,
    /<button[^>]*id="edit-submit-button"[^>]*type="submit"[^>]*disabled/s,
    'edit save button should start disabled until required fields are filled'
  );
  assert.match(
    template,
    /function updateEditSubmitState\(\) \{[\s\S]*editSubmitButton\.disabled = !\(editRuleSelect\.value && editDescription\.value\.trim\(\)\);/s,
    'client validation should enable saving only when rule and details are filled'
  );
});

test('POST /violation-reports/:id/edit rejects empty rule or details on the server', () => {
  const route = readProjectFile('routes/violation-reports.js');

  assert.match(
    route,
    /const description = \(req\.body\.description \|\| ''\)\.trim\(\);/,
    'route should trim edit description before validation and persistence'
  );
  assert.match(
    route,
    /const ruleId = parseInt\(req\.body\.rule_id, 10\);/,
    'route should parse edit rule_id before validation and persistence'
  );
  assert.match(
    route,
    /if \(!Number\.isFinite\(ruleId\) \|\| ruleId <= 0\)/,
    'route should reject missing or invalid edit rule'
  );
  assert.match(
    route,
    /if \(!description\)/,
    'route should reject empty edit details'
  );
  assert.match(
    route,
    /\[description, ruleId, req\.params\.id\]/,
    'report update should persist the validated edit fields'
  );
  assert.match(
    route,
    /\[description, ruleId, report\.violation_id\]/,
    'linked violation update should persist the validated edit fields'
  );
});
