const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('deleted data management view lets admins select specific rows for permanent deletion', () => {
  const view = readProjectFile('views/data/manage.ejs');

  assert.match(
    view,
    /id="select-all-deleted-rows"/,
    'deleted rows table should expose a select-all checkbox'
  );
  assert.match(
    view,
    /name="selected_registration_ids"[\s\S]*form="hard-delete-soft-deleted-form"[\s\S]*data-deleted-row-checkbox/,
    'each deleted row should include a checkbox submitted with the hard delete form'
  );
  assert.match(
    view,
    /id="selected-deleted-count"/,
    'the hard delete bar should show how many deleted rows are selected'
  );
  assert.match(
    view,
    /querySelectorAll\('\[data-deleted-row-checkbox\]'\)[\s\S]*submit-hard-delete[\s\S]*selected-deleted-count/s,
    'client-side script should keep the selected count and submit button in sync'
  );
});

test('hard deleting soft-deleted data is scoped to selected registration rows', () => {
  const route = readProjectFile('routes/data.js');

  assert.match(
    route,
    /const selectedRegistrationIds = parseIds\(req\.body\.selected_registration_ids\)/,
    'hard delete route should parse selected registration ids from the form'
  );
  assert.match(
    route,
    /if \(!selectedRegistrationIds\.length\)[\s\S]*return res\.redirect\(returnUrl\)/,
    'hard delete route should reject submissions with no selected rows'
  );
  assert.match(
    route,
    /fetchSoftDeletedSnapshots\(conn, filters, selectedRegistrationIds\)/,
    'snapshot logging should only load selected soft-deleted rows'
  );
  assert.match(
    route,
    /hardDeleteSoftDeletedRows\(conn, filters, selectedRegistrationIds\)/,
    'permanent deletion should only remove selected soft-deleted rows'
  );
  assert.match(
    route,
    /AND r\.id IN \(\$\{placeholders\(selectedRegistrationIds\)\}\)/,
    'soft-deleted queries should constrain permanent deletion to selected registration ids'
  );
});
