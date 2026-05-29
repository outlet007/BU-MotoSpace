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
    /const deletedDetailHref = rpt\.source === 'report'\s*\?\s*'\/violation-reports\/' \+ rpt\.id \+ '\?status_filter=deleted'\s*:\s*\(rpt\.violation_id \? '\/violations\/' \+ rpt\.violation_id : ''\);/,
    'deleted review report rows should link to their review detail page even without a linked violation'
  );
  assert.match(
    template,
    /const restoreAction = rpt\.source === 'report' \? '\/violation-reports\/' \+ rpt\.id \+ '\/restore' : '\/violations\/' \+ rpt\.id \+ '\/restore';/,
    'deleted table rows should restore through the correct source endpoint'
  );
  assert.match(
    template,
    /<form method="POST" action="<%= restoreAction %>"[\s\S]*data-delete-confirm[\s\S]*rotate-ccw/,
    'deleted table rows should include a restore action'
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
    /<% if \(viewingDeleted\) \{ %>\s*<span class="badge badge-danger">[\s\S]*ถูกลบชั่วคราว[\s\S]*<\/span>[\s\S]*<div class="text-sm text-slate-500 mt-1">ลบโดย <%= rpt\.deleted_by_name \|\| '-' %><\/div>[\s\S]*<% \} else \{ %>\s*<%= rpt\.reported_by_name %>/,
    'deleted view status cell should mirror the deleted registrations status badge and deleted-by line'
  );
  assert.match(
    template,
    /<p class="text-sm text-slate-500 mt-1">ลบโดย <%= rpt\.deleted_by_name \|\| '-' %><\/p>/,
    'mobile deleted cards should show deleted-by at 14px'
  );
  assert.match(
    template,
    /<p class="text-sm text-red-500 mt-1">เหตุผล: <%= rpt\.delete_reason \|\| '-' %><\/p>/,
    'mobile deleted cards should show delete reason at 14px'
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

test('GET /violation-reports supports the deleted review reports view', () => {
  const route = readProjectFile('routes/violation-reports.js');

  assert.match(
    route,
    /const isDeletedView = status_filter === 'deleted';/,
    'route should detect the deleted review reports view'
  );
  assert.match(
    route,
    /FROM violation_reports vr[\s\S]*vr\.deleted_at IS NOT NULL/,
    'deleted view should query soft-deleted review reports'
  );
  assert.match(
    route,
    /NOT EXISTS \(\s*SELECT 1\s*FROM violation_reports linked_report[\s\S]*linked_report\.violation_id = v\.id[\s\S]*linked_report\.deleted_at IS NOT NULL/s,
    'deleted view should avoid duplicating confirmed reports and their linked violations'
  );
  assert.match(
    route,
    /COUNT\(\*\) as cnt FROM \(\$\{deletedItemsSql\}\) deleted_items/,
    'route should count all deleted review rows for the dashboard'
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

test('deleted review reports can be restored', () => {
  const route = readProjectFile('routes/violation-reports.js');

  assert.match(
    route,
    /router\.post\('\/:id\/restore', isHead, verifyCsrf, async \(req, res\) => \{/,
    'violation reports route should expose a restore endpoint'
  );
  assert.match(
    route,
    /SELECT id, violation_id\s+FROM violation_reports\s+WHERE id = \?\s+AND deleted_at IS NOT NULL\s+FOR UPDATE/s,
    'restore route should only restore soft-deleted review reports'
  );
  assert.match(
    route,
    /if \(report\.violation_id\) \{[\s\S]*UPDATE violations\s+SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL[\s\S]*WHERE id = \?/s,
    'restore route should restore the linked violation when one exists'
  );
  assert.match(
    route,
    /UPDATE violation_reports\s+SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL\s+WHERE id = \?/s,
    'restore route should clear soft-delete metadata on the review report'
  );
  assert.match(
    route,
    /res\.redirect\('\/violation-reports\?status_filter=deleted'\)/,
    'restore route should return to the deleted review reports view'
  );
});

test('deleted review reports can be opened as read-only details', () => {
  const route = readProjectFile('routes/violation-reports.js');
  const template = readProjectFile('views/violation-reports/detail.ejs');

  assert.match(
    route,
    /const viewingDeleted = req\.query\.status_filter === 'deleted';/,
    'detail route should detect deleted detail mode'
  );
  assert.match(
    route,
    /AND \(\s*\(\? = 1 AND vr\.deleted_at IS NOT NULL\)\s*OR\s*\(\? = 0 AND vr\.deleted_at IS NULL AND r\.deleted_at IS NULL\)\s*\)/s,
    'detail route should allow soft-deleted reports only in deleted mode'
  );
  assert.match(
    route,
    /da\.full_name AS deleted_by_name/,
    'detail route should fetch deleted-by admin for deleted reports'
  );
  assert.match(
    template,
    /<% if \(r\.deleted_at\) \{ %>[\s\S]*ถูกลบชั่วคราว[\s\S]*r\.delete_reason/s,
    'detail page should show a deleted banner with delete metadata'
  );
  assert.match(
    template,
    /<span class="ml-auto text-sm text-slate-500">ลบโดย <%= r\.deleted_by_name %><\/span>/,
    'detail deleted banner should show deleted-by at 14px'
  );
  assert.match(
    template,
    /<span class="text-sm text-red-500">เหตุผล: <%= r\.delete_reason %><\/span>/,
    'detail deleted banner should show delete reason at 14px'
  );
  assert.match(
    template,
    /<a href="<%= r\.deleted_at \? '\/violation-reports\?status_filter=deleted' : '\/violation-reports' %>"/,
    'detail back link should return deleted records to the deleted tab'
  );
  assert.match(
    template,
    /<% if \(!r\.deleted_at && \['pending', 'confirmed', 'rejected'\]\.includes\(r\.status\)\) \{ %>/,
    'deleted details should hide process and management actions'
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
