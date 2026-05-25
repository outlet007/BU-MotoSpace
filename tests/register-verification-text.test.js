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
