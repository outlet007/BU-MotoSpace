const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('violation report rows use the same detail href as the detail button', () => {
  const template = readProjectFile('views/violation-reports/index.ejs');
  const route = readProjectFile('routes/violation-reports.js');

  assert.match(
    route,
    /SELECT vr\.id, vr\.status, vr\.violation_id, vr\.reported_at/,
    'list query should include the linked violation id for confirmed reports'
  );
  assert.match(
    template,
    /const detailHref = '\/violation-reports\/' \+ rpt\.id;/,
    'active reports should always open the review detail page'
  );
  assert.doesNotMatch(
    template,
    /const detailHref = rpt\.status === 'confirmed' && rpt\.violation_id\s*\?\s*'\/violations\/' \+ rpt\.violation_id\s*:\s*'\/violation-reports\/' \+ rpt\.id;/,
    'confirmed reports should not navigate to the violation detail page from the review list'
  );
  assert.match(
    template,
    /href="<%= viewingDeleted \? '#' : detailHref %>"/,
    'mobile card should use the shared detail href'
  );
  assert.match(
    template,
    /data-href="<%= detailHref %>"/,
    'clickable table rows should use the same href as the detail button'
  );
  assert.match(
    template,
    /<a href="<%= detailHref %>"[\s\S]*id="view-report-<%= rpt\.id %>"/,
    'detail button should use the shared detail href'
  );
});

test('violation reports list keeps delete out of the table action column', () => {
  const template = readProjectFile('views/violation-reports/index.ejs');

  assert.match(
    template,
    /<% if \(!viewingDeleted\) \{ %>\s*<th>[\s\S]*?<\/th>\s*<% } %>\s*<th><\/th>/,
    'table action column should stay unlabeled'
  );
  assert.doesNotMatch(
    template,
    /<th>จัดการ<\/th>/,
    'table action column should not show the manage wording'
  );
  assert.doesNotMatch(
    template,
    /action="\/violation-reports\/<%= rpt\.id %>\/delete"/,
    'delete button should not be rendered in the table rows'
  );
});

test('violation report detail renders process and management as separate cards', () => {
  const template = readProjectFile('views/violation-reports/detail.ejs');

  assert.match(
    template,
    /<div data-action-group="process" class="card p-5">[\s\S]*id="btn-confirm-<%= r\.id %>"[\s\S]*id="btn-reject-<%= r\.id %>"/,
    'process card should contain confirm and reject buttons'
  );
  assert.match(
    template,
    /<div data-action-group="manage" class="card p-5">[\s\S]*id="btn-edit-<%= r\.id %>"[\s\S]*action="\/violation-reports\/<%= r\.id %>\/delete"[\s\S]*data-delete-confirm[\s\S]*data-delete-reason-required="true"[\s\S]*trash-2/,
    'management card should contain edit and delete buttons'
  );
  assert.doesNotMatch(
    template,
    /class="card p-5 space-y-4"[\s\S]*data-action-group="process"[\s\S]*data-action-group="manage"/,
    'process and management groups should not be nested inside one shared card'
  );
});

test('violation report detail orders right-side cards by workflow priority', () => {
  const template = readProjectFile('views/violation-reports/detail.ejs');

  assert.match(
    template,
    /<!-- RIGHT:[\s\S]*?-->\s*<div class="space-y-6">[\s\S]*data-action-group="process"[\s\S]*data-action-group="manage"[\s\S]*href="\/registrations\/<%= r\.registration_id %>"[\s\S]*data-lucide="bike"/,
    'right-side cards should render process, manage, registration info, then vehicle photos'
  );
});

test('violation report detail opens vehicle photos in the shared lightbox', () => {
  const template = readProjectFile('views/violation-reports/detail.ejs');

  assert.match(
    template,
    /<% if \(r\.evidence_photo \|\| r\.motorcycle_photo \|\| r\.plate_photo\) \{ %>[\s\S]*id="lightbox"[\s\S]*id="lightbox-img"/,
    'detail page should render a shared lightbox when any detail photo exists'
  );
  assert.match(
    template,
    /<img src="<%= signedUrl\(r\.motorcycle_photo\) %>" alt="Motorcycle"[\s\S]*data-lightbox-src="<%= signedUrl\(r\.motorcycle_photo\) %>"/,
    'motorcycle photo should provide a lightbox source'
  );
  assert.match(
    template,
    /<img src="<%= signedUrl\(r\.plate_photo\) %>" alt="Plate"[\s\S]*data-lightbox-src="<%= signedUrl\(r\.plate_photo\) %>"/,
    'plate photo should provide a lightbox source'
  );
  assert.match(
    template,
    /document\.querySelectorAll\('\[data-lightbox-src\]'\)\.forEach\(function\(trigger\) \{[\s\S]*openLightbox\(trigger\);/s,
    'all lightbox-enabled images should open the shared lightbox'
  );
  assert.match(
    template,
    /lightboxImg\.src = trigger\.dataset\.lightboxSrc \|\| trigger\.src;/,
    'lightbox should show the clicked image source'
  );
});

test('POST /violation-reports/:id/delete soft-deletes report data and linked violations', () => {
  const route = readProjectFile('routes/violation-reports.js');

  assert.match(
    route,
    /router\.post\('\/:id\/delete', isHead, verifyCsrf, async \(req, res\) => \{/,
    'violation reports should expose a protected delete endpoint'
  );
  assert.match(
    route,
    /const deleteReason = \(req\.body\.delete_reason \|\| ''\)\.trim\(\);/,
    'delete route should trim and validate delete_reason'
  );
  assert.match(
    route,
    /if \(!deleteReason\)/,
    'delete route should reject empty delete reasons'
  );
  assert.match(
    route,
    /if \(report\.violation_id\) \{[\s\S]*UPDATE violations\s+SET deleted_at = NOW\(\), deleted_by = \?, delete_reason = \?[\s\S]*WHERE id = \? AND deleted_at IS NULL/s,
    'delete route should soft-delete the linked violation when one exists'
  );
  assert.match(
    route,
    /UPDATE violation_reports\s+SET deleted_at = NOW\(\), deleted_by = \?, delete_reason = \?\s+WHERE id = \? AND deleted_at IS NULL/s,
    'delete route should soft-delete the review report itself'
  );
});
