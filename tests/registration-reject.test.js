const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function assertHiddenInlineError(template, errorId) {
  assert.match(
    template,
    new RegExp(`<p id="${errorId}"[^>]*style="display:none; font-size:14px;[^"]*"[^>]*>\\s*กรุณากรอกหมายเหตุก่อนยืนยัน\\s*</p>`),
    `${errorId} should be hidden by default, use 14px text, and use the shared required note message`
  );
}

test('registration reject modal shows the note error only after empty submit', () => {
  const template = readProjectFile('views/registrations/detail.ejs');

  assert.match(
    template,
    /<form[^\n]*id="registration-reject-form"[^\n]*novalidate/,
    'registration reject form should use custom inline validation'
  );
  assert.match(
    template,
    /<textarea[^>]*id="registration-reject-notes"[^>]*name="notes"[^>]*required/s,
    'registration reject notes textarea should be required'
  );
  assertHiddenInlineError(template, 'registration-reject-notes-error');
  assert.match(
    template,
    /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-lucide="x-circle" aria-hidden="true" class="lucide lucide-x-circle w-4 h-4 text-red-500"><circle cx="12" cy="12" r="10"><\/circle><path d="m15 9-6 6"><\/path><path d="m9 9 6 6"><\/path><\/svg>/,
    'registration reject modal header should use the inline x-circle svg icon'
  );
  assert.doesNotMatch(
    template,
    /<div class="w-10 h-10 rounded-xl bg-red-100 text-red-600 flex items-center justify-center">\s*<i data-lucide="x-circle" class="w-5 h-5"><\/i>\s*<\/div>/,
    'registration reject modal header should not use the old icon wrapper'
  );
  assert.match(
    template,
    /registrationRejectForm\.addEventListener\('submit', function\(e\) \{[\s\S]*if \(!registrationRejectNotes\.value\.trim\(\)\) \{[\s\S]*e\.preventDefault\(\);[\s\S]*registrationRejectNotesError\.style\.display = 'block';[\s\S]*registrationRejectNotes\.focus\(\);/s,
    'registration reject form should display the inline error only when submitted empty'
  );
  assert.match(
    template,
    /registrationRejectNotes\.addEventListener\('input', function\(\) \{[\s\S]*registrationRejectNotesError\.style\.display = 'none';/s,
    'typing a registration reject note should hide the inline error'
  );
  assert.match(
    template,
    /<div class="flex gap-3 justify-end pt-2">\s*<button type="button" id="cancel-reject-modal" class="btn btn-secondary">ยกเลิก<\/button>\s*<button type="submit" class="btn" style="background:#dc2626;color:#fff;">/s,
    'registration reject action buttons should match the violation reject modal sizing'
  );
  assert.match(
    template,
    /<button type="submit" class="btn" style="background:#dc2626;color:#fff;">\s*<i data-lucide="x-circle" class="lucide lucide-x-circle w-4 h-4"><\/i>/s,
    'registration reject confirm button should include the x-circle lucide icon classes'
  );
  assert.doesNotMatch(
    template,
    /id="cancel-reject-modal" class="btn btn-secondary flex-1 justify-center"|type="submit" class="btn btn-danger flex-1 justify-center"/,
    'registration reject buttons should not use the wider flex-1 sizing'
  );
});

test('POST /registrations/:id/reject rejects empty notes on the server', () => {
  const route = readProjectFile('routes/registrations.js');

  assert.match(
    route,
    /const rejectionNote = \(req\.body\.notes \|\| ''\)\.trim\(\);/,
    'route should trim registration reject notes before validation and persistence'
  );
  assert.match(
    route,
    /if \(!rejectionNote\)/,
    'route should reject empty registration reject notes'
  );
  assert.match(
    route,
    /กรุณากรอกหมายเหตุก่อนยืนยัน/,
    'route should show the shared required note message'
  );
  assert.match(
    route,
    /\[rejectionNote, req\.session\.admin\.id, req\.params\.id, req\.params\.id\]/,
    'vehicle rejection update should persist the validated note'
  );
  assert.match(
    route,
    /syncRegistrationStatusFromPublicVehicles\(conn, Number\(req\.params\.id\), req\.session\.admin\.id, rejectionNote\)/,
    'registration status sync should use the validated note'
  );
});
