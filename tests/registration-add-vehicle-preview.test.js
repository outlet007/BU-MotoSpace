const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('add vehicle modal previews selected motorcycle and plate photos', () => {
  const template = readProjectFile('views/registrations/detail.ejs');

  assert.match(
    template,
    /id="add-vehicle-motorcycle-photo"[\s\S]*data-file-name-target="add-vehicle-motorcycle-photo-name"[\s\S]*data-preview-target="add-vehicle-motorcycle-photo-preview"/,
    'motorcycle file input should point to a preview image'
  );
  assert.match(
    template,
    /<img id="add-vehicle-motorcycle-photo-preview"[\s\S]*alt="ตัวอย่างรูปรถ"/,
    'add vehicle modal should render a motorcycle preview image'
  );
  assert.match(
    template,
    /id="add-vehicle-plate-photo"[\s\S]*data-file-name-target="add-vehicle-plate-photo-name"[\s\S]*data-preview-target="add-vehicle-plate-photo-preview"/,
    'plate file input should point to a preview image'
  );
  assert.match(
    template,
    /<img id="add-vehicle-plate-photo-preview"[\s\S]*alt="ตัวอย่างรูปป้ายทะเบียน"/,
    'add vehicle modal should render a plate preview image'
  );
  assert.match(
    template,
    /var preview = input\.dataset\.previewTarget \? document\.getElementById\(input\.dataset\.previewTarget\) : null;[\s\S]*URL\.createObjectURL\(file\)[\s\S]*preview\.classList\.remove\('hidden'\)/,
    'file change handler should create an object URL and show the preview'
  );
  assert.match(
    template,
    /form\.querySelectorAll\('img\[data-file-preview\]'\)\.forEach\(function\(preview\) \{[\s\S]*URL\.revokeObjectURL\(preview\.dataset\.objectUrl\)[\s\S]*preview\.classList\.add\('hidden'\)/,
    'closing the add vehicle modal should clear and revoke previews'
  );
});
