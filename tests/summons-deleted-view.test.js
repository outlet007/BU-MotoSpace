const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('summons appointment queries separate active and temporarily deleted rows', () => {
  const route = readProjectFile('routes/reports.js');

  assert.match(
    route,
    /status = 'active'/,
    'fetchSummonsAppointments should accept an active/deleted status option'
  );
  assert.match(
    route,
    /const isDeletedView = status === 'deleted';/,
    'fetchSummonsAppointments should detect deleted view mode'
  );
  assert.match(
    route,
    /let where = isDeletedView\s*\?\s*'WHERE sa\.deleted_at IS NOT NULL'\s*:\s*'WHERE sa\.deleted_at IS NULL AND r\.deleted_at IS NULL';/,
    'active summons history should exclude soft-deleted appointments and deleted registrations'
  );
  assert.match(
    route,
    /da\.full_name AS deleted_by_name/,
    'deleted summons rows should include the admin who deleted the record'
  );
  assert.match(
    route,
    /sa\.delete_reason/,
    'deleted summons rows should include delete reason'
  );
});

test('GET /reports/summons loads a deleted summons section', () => {
  const route = readProjectFile('routes/reports.js');

  assert.match(
    route,
    /const activeTab = req\.query\.active_tab === 'completed'\s*\?\s*'completed'\s*:\s*req\.query\.active_tab === 'deleted'\s*\?\s*'deleted'\s*:\s*'pending';/,
    'summons route should allow the deleted tab'
  );
  assert.match(
    route,
    /const deletedSummonsReport = await fetchSummonsAppointments\(conn, \{[\s\S]*status: 'deleted'[\s\S]*\}\);/,
    'summons route should fetch deleted appointments separately'
  );
  assert.match(
    route,
    /deletedSummonsAppointments: deletedSummonsReport\.rows/,
    'summons route should pass deleted appointments to the template'
  );
  assert.match(
    route,
    /deletedSummonsTotal: deletedSummonsReport\.total/,
    'summons route should pass deleted appointment count to the template'
  );
});

test('summons report UI exposes temporarily deleted appointments', () => {
  const template = readProjectFile('views/reports/summons.ejs');

  assert.match(
    template,
    /data-metric-tab="deleted"/,
    'summons report should include a deleted metric tab'
  );
  assert.match(
    template,
    /<(?:p|span)[^>]*>ถูกลบชั่วคราว<\/(?:p|span)>/,
    'deleted metric tab should use shared deleted wording'
  );
  assert.match(
    template,
    /id="summoned-deleted"[\s\S]*activeTab === 'deleted'/,
    'summons report should render a deleted tab panel'
  );
  assert.match(
    template,
    /deletedSummonsAppointments/,
    'deleted tab should render deleted summons appointments'
  );
  assert.match(
    template,
    /item\.deleted_by_name/,
    'deleted summons rows should show who deleted them'
  );
  assert.match(
    template,
    /item\.delete_reason/,
    'deleted summons rows should show delete reason'
  );
});
