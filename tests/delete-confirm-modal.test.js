const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('delete confirmation required note message uses 14px text', () => {
  const template = readProjectFile('views/partials/sidebar.ejs');

  assert.match(
    template,
    /<p id="delete-confirm-reason-error"[^>]*style="display:none; font-size:14px;[^"]*"[^>]*>\s*กรุณากรอกหมายเหตุก่อนยืนยัน\s*<\/p>/,
    'delete confirm note error should remain hidden by default and use 14px text'
  );
});
