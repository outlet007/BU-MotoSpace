const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function assertRequiredLabel(template, inputId, labelText) {
  const escapedLabel = labelText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  assert.match(
    template,
    new RegExp(`<label class="label" for="${inputId}">${escapedLabel}\\s*<span class="text-red-500">\\*</span>\\s*</label>`),
    `${labelText} label should show a red required asterisk`
  );
}

test('summons confirm modal marks scheduled time and note as required before saving', () => {
  const template = readProjectFile('views/reports/summons.ejs');

  assertRequiredLabel(template, 'summons-scheduled-at', 'วันเวลานัดหมาย');
  assertRequiredLabel(template, 'summons-note', 'หมายเหตุ');
  assert.match(
    template,
    /<input[^>]*id="summons-scheduled-at"[^>]*name="scheduled_at"[^>]*required/s,
    'scheduled time input should be required'
  );
  assert.match(
    template,
    /<textarea[^>]*id="summons-note"[^>]*name="note"[^>]*required/s,
    'summons note textarea should be required'
  );
  assert.match(
    template,
    /<button[^>]*id="summons-submit-button"[^>]*type="submit"[^>]*disabled/s,
    'save summons button should start disabled until required fields are filled'
  );
  assert.match(
    template,
    /function updateSummonsSubmitState\(\) \{[\s\S]*submitButton\.disabled = !\(scheduledInput\.value && noteInput\.value\.trim\(\)\);/s,
    'client validation should enable saving only when scheduled time and note are filled'
  );
});

test('summons report uses attachment wording everywhere', () => {
  const template = readProjectFile('views/reports/summons.ejs');

  assert.match(
    template,
    /เอกสารแนบ/,
    'summons report should show the attachment wording'
  );
  assert.doesNotMatch(
    template,
    /เอกสารที่เป็นลายลักษณ์อักษร/,
    'summons report should not show the old written-document wording'
  );
});

test('summons report metric card numbers use 30px text', () => {
  const template = readProjectFile('views/reports/summons.ejs');

  assert.match(
    template,
    /\.metric-card \.mc-value \{[^}]*font-size:\s*30px;[^}]*\}/s,
    'summons report card number text should be 30px'
  );
});

test('POST /reports/summons/:registrationId/confirm rejects empty note on the server', () => {
  const route = readProjectFile('routes/reports.js');

  assert.match(
    route,
    /const note = \(req\.body\.note \|\| ''\)\.trim\(\);/,
    'route should trim summons note before validation and persistence'
  );
  assert.match(
    route,
    /if \(!note\)/,
    'route should reject empty summons note'
  );
  assert.match(
    route,
    /กรุณากรอกหมายเหตุก่อนบันทึกการเรียกพบ/,
    'route should show a clear required note message'
  );
  assert.match(
    route,
    /note,\s*\n\s*writtenDocument,/,
    'route should persist the validated summons note directly'
  );
});
