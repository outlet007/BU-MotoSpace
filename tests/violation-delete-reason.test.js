const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('violation delete confirmation requires a reason before deleting', () => {
  const template = readProjectFile('views/violations/detail.ejs');

  assert.match(
    template,
    /action="\/violations\/<%= v\.id %>\/delete"[\s\S]*data-delete-confirm[\s\S]*data-delete-reason-required="true"/,
    'delete violation form should require a reason in the shared delete confirmation modal'
  );
  assert.match(
    template,
    /data-delete-reason-placeholder="ระบุเหตุผลในการลบรายการแจ้ง"/,
    'delete violation form should explain which reason to enter'
  );
});

test('POST /violations/:id/delete rejects empty delete reason and stores the reason', () => {
  const route = readProjectFile('routes/violations.js');

  assert.match(
    route,
    /const deleteReason = \(req\.body\.delete_reason \|\| ''\)\.trim\(\);/,
    'route should trim delete_reason before validation and persistence'
  );
  assert.match(
    route,
    /if \(!deleteReason\)/,
    'route should reject empty delete reason'
  );
  assert.match(
    route,
    /กรุณากรอกเหตุผลก่อนลบรายการแจ้ง/,
    'route should show a clear required reason message'
  );
  assert.match(
    route,
    /UPDATE violations\s+SET deleted_at = NOW\(\), deleted_by = \?, delete_reason = \?\s+WHERE id = \?/s,
    'route should soft-delete violations and store the validated reason'
  );
  assert.match(
    route,
    /\[req\.session\.admin\.id, deleteReason, violationId\]/,
    'route should persist the validated delete reason'
  );
});
