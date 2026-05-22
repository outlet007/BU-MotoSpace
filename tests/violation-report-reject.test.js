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

function assertHiddenInlineError(template, errorId) {
  assert.match(
    template,
    new RegExp(`<p id="${errorId}"[^>]*style="display:none; font-size:14px;[^"]*"[^>]*>\\s*กรุณากรอกหมายเหตุก่อนยืนยัน\\s*</p>`),
    `${errorId} should be hidden by default, use 14px text, and use the shared required note message`
  );
}

test('reject modal requires a reason and shows the note error only after empty submit', () => {
  const template = readProjectFile('views/violation-reports/detail.ejs');

  assert.match(template, /ปฏิเสธการกระทำผิดกฏ/);
  assert.doesNotMatch(
    template,
    /<i data-lucide="x-circle" class="w-4 h-4 text-red-500"><\/i> ปฏิเสธรายการ/,
    'reject modal title should use the updated wording'
  );
  assert.match(template, /กรุณาระบุเหตุผลในการปฏิเสธรายการนี้/);
  assert.doesNotMatch(template, /เหตุผล \(ไม่บังคับ\)/);
  assert.doesNotMatch(template, /กรุณาระบุเหตุผลในการปฏิเสธรายการนี้ \(ถ้ามี\)/);
  assert.doesNotMatch(
    template,
    /<p class="text-sm text-red-600 mb-4">กรุณากรอกหมายเหตุก่อนยืนยัน<\/p>/,
    'required note message should not be visible before submit'
  );
  assertRequiredLabel(template, 'เหตุผล');
  assert.match(
    template,
    /<form[^\n]*id="reject-form"[^\n]*novalidate/,
    'reject form should use custom inline validation'
  );
  assert.match(
    template,
    /<textarea[^>]*id="reject-review-note"[^>]*name="review_note"[^>]*required/s,
    'reject reason textarea should be required'
  );
  assertHiddenInlineError(template, 'reject-review-note-error');
  assert.match(
    template,
    /rejectForm\.addEventListener\('submit', function\(e\) \{[\s\S]*if \(!rejectReviewNote\.value\.trim\(\)\) \{[\s\S]*e\.preventDefault\(\);[\s\S]*rejectNoteError\.style\.display = 'block';[\s\S]*rejectReviewNote\.focus\(\);/s,
    'reject form should display the inline error only when submitted empty'
  );
  assert.match(
    template,
    /rejectReviewNote\.addEventListener\('input', function\(\) \{[\s\S]*rejectNoteError\.style\.display = 'none';/s,
    'typing a reason should hide the inline error'
  );
});

test('POST /violation-reports/:id/reject rejects empty reason on the server', () => {
  const route = readProjectFile('routes/violation-reports.js');

  assert.match(
    route,
    /const reviewNote = \(req\.body\.review_note \|\| ''\)\.trim\(\);/,
    'route should trim review_note before validation and persistence'
  );
  assert.match(
    route,
    /if \(!reviewNote\)/,
    'route should reject empty review note'
  );
  assert.match(
    route,
    /กรุณากรอกหมายเหตุก่อนยืนยัน/,
    'route should show a clear validation message'
  );
  assert.match(
    route,
    /\[req\.session\.admin\.id, reviewNote, report\.violation_id\]/,
    'linked violation delete reason should use the validated review note'
  );
  assert.match(
    route,
    /\[req\.session\.admin\.id, reviewNote, req\.params\.id\]/,
    'rejected report should persist the validated review note'
  );
});
