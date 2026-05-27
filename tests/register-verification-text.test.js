const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('registration verification copy uses the updated student discipline regulation in Thai and English', () => {
  const template = readProjectFile('views/register.ejs');

  assert.match(
    template,
    /ข้อบังคับมหาวิทยาลัยกรุงเทพ ว่าด้วยวินัยนักศึกษา พ\.ศ\. 2568/,
    'Thai verification copy should reference the updated Bangkok University student discipline regulation'
  );
  assert.match(
    template,
    /Bangkok University Regulations on Student Discipline, B\.E\. 2568 \(2025\)/,
    'English verification copy should translate the updated regulation name'
  );
  assert.doesNotMatch(
    template,
    /ข้อบังคับฯ ว่าด้วยมารยาท ความประพฤติและวินัยนักศึกษา/,
    'Thai verification copy should no longer use the old regulation wording'
  );
  assert.doesNotMatch(
    template,
    /Bangkok University Regulation on Student Discipline B\.E\. 2568|Student Code of Conduct/,
    'English verification copy should no longer use the old generic student code wording'
  );
});

test('registration verification consent is only required for student registrations', () => {
  const template = readProjectFile('views/register.ejs');

  assert.match(
    template,
    /<div id="pdpa-verification-section" class="bg-gradient-to-r from-brand-50 to-emerald-50 rounded-2xl p-5 border border-brand-100">\s*<div class="flex items-center gap-2 mb-3">\s*<i data-lucide="badge-check"/,
    'verification consent section should have a stable id on the verification block'
  );
  assert.match(
    template,
    /const verificationSection = document\.getElementById\('pdpa-verification-section'\);/,
    'tab switching should find the verification consent section'
  );
  assert.match(
    template,
    /verificationSection\.classList\.toggle\('hidden', !isStudent\);/,
    'staff tab should hide the verification consent section'
  );
  assert.match(
    template,
    /verificationConsent\.disabled = !isStudent;/,
    'staff tab should disable the hidden verification checkbox so it is not submitted'
  );
  assert.match(
    template,
    /verificationConsent\.required = isStudent;/,
    'verification checkbox should only be required for student registrations'
  );
  assert.match(
    template,
    /const needsVerification = !userTypeInput \|\| userTypeInput\.value === 'student';/,
    'submit button logic should require verification only for student registrations'
  );
});
