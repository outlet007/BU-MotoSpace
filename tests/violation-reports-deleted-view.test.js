const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('violation reports dashboard exposes temporarily deleted violations', () => {
  const template = readProjectFile('views/violation-reports/index.ejs');

  assert.match(
    template,
    /<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">/,
    'dashboard cards should use the same one-row desktop grid as registrations'
  );
  assert.match(
    template,
    /href="\/violation-reports\?status_filter=deleted"/,
    'dashboard should link to temporarily deleted violations'
  );
  assert.match(
    template,
    /archive-x/,
    'deleted dashboard card should use the archive icon'
  );
  assert.match(
    template,
    /ถูกลบชั่วคราว/,
    'deleted dashboard card should use the shared deleted wording'
  );
  assert.match(
    template,
    /<option value="deleted"[\s\S]*ถูกลบชั่วคราว[\s\S]*<\/option>/,
    'status filter should include temporarily deleted violations'
  );
  assert.match(
    template,
    /rpt\.deleted_by_name/,
    'deleted view should display who deleted the violation'
  );
  assert.match(
    template,
    /rpt\.delete_reason/,
    'deleted view should display the delete reason'
  );
  assert.match(
    template,
    /<% if \(viewingDeleted\) \{ %>[\s\S]*href="\/violations\/<%= rpt\.id %>"[\s\S]*action="\/violations\/<%= rpt\.id %>\/restore"[\s\S]*data-delete-confirm[\s\S]*rotate-ccw/,
    'deleted table rows should include detail and restore actions'
  );
  assert.match(
    template,
    /<% if \(!viewingDeleted\) \{ %>\s*<th>[\s\S]*?<\/th>\s*<% } %>\s*<th><\/th>/,
    'status column header should be hidden in the deleted view'
  );
  assert.match(
    template,
    /<th><%= viewingDeleted \? 'สถานะ' : 'แจ้งโดย' %><\/th>/,
    'deleted view should rename the reported-by column to status'
  );
  assert.match(
    template,
    /<% if \(viewingDeleted\) \{ %>\s*<span class="badge badge-danger">[\s\S]*ถูกลบชั่วคราว[\s\S]*<\/span>[\s\S]*<div class="text-xs text-slate-500 mt-1">ลบโดย <%= rpt\.deleted_by_name \|\| '-' %><\/div>[\s\S]*<% \} else \{ %>\s*<%= rpt\.reported_by_name %>/,
    'deleted view status cell should mirror the deleted registrations status badge and deleted-by line'
  );
  assert.match(
    template,
    /<td colspan="<%= viewingDeleted \? 11 : 12 %>"/,
    'empty table state should use the deleted-view column count'
  );
  assert.doesNotMatch(
    template,
    /<span class="text-xs text-slate-400">[\s\S]*?<\/span>/,
    'deleted table rows should not show the archived-history placeholder text'
  );
});

test('GET /violation-reports supports the deleted violations view', () => {
  const route = readProjectFile('routes/violation-reports.js');

  assert.match(
    route,
    /const isDeletedView = status_filter === 'deleted';/,
    'route should detect the deleted violations view'
  );
  assert.match(
    route,
    /FROM violations v[\s\S]*v\.deleted_at IS NOT NULL/,
    'deleted view should query soft-deleted violations'
  );
  assert.match(
    route,
    /COUNT\(\*\) as cnt FROM violations v[\s\S]*v\.deleted_at IS NOT NULL/,
    'route should count soft-deleted violations for the dashboard'
  );
  assert.match(
    route,
    /deleted_by_name/,
    'deleted view should fetch the admin name that deleted the violation'
  );
  assert.match(
    route,
    /delete_reason/,
    'deleted view should fetch the stored delete reason'
  );
  assert.match(
    route,
    /viewingDeleted: isDeletedView/,
    'route should pass deleted-view state to the template'
  );
});

test('soft-deleted violations can be viewed and restored', () => {
  const route = readProjectFile('routes/violations.js');

  assert.doesNotMatch(
    route,
    /WHERE v\.id = \?\s+AND v\.deleted_at IS NULL\s+AND r\.deleted_at IS NULL/,
    'violation detail route should not block soft-deleted violations'
  );
  assert.match(
    route,
    /router\.post\('\/:id\/restore', isHead, verifyCsrf, async \(req, res\) => \{/,
    'violations route should expose a restore endpoint for soft-deleted rows'
  );
  assert.match(
    route,
    /SELECT id FROM violations\s+WHERE id = \?\s+AND deleted_at IS NOT NULL/,
    'restore route should only restore soft-deleted violations'
  );
  assert.match(
    route,
    /UPDATE violations\s+SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL\s+WHERE id = \?/s,
    'restore route should clear soft-delete metadata'
  );
  assert.match(
    route,
    /res\.redirect\('\/violation-reports\?status_filter=deleted'\)/,
    'restore route should return to the deleted violations view'
  );
});
