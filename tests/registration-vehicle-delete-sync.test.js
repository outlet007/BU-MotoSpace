const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('deleting a vehicle syncs its source registration so it does not remain pending', () => {
  const route = readProjectFile('routes/registrations.js');

  assert.match(
    route,
    /SELECT owner_registration_id, source_registration_id, created_by[\s\S]*FROM vehicles[\s\S]*WHERE id = \?[\s\S]*AND \(owner_registration_id = \? OR source_registration_id = \?\)[\s\S]*AND deleted_at IS NULL[\s\S]*FOR UPDATE/s,
    'vehicle delete route should lock and inspect the vehicle before soft-deleting it'
  );
  assert.match(
    route,
    /vehicle\.source_registration_id \|\| \(vehicle\.created_by == null \? vehicle\.owner_registration_id : null\)/,
    'public extra vehicles without source_registration_id should still sync their owner registration when deleted'
  );
  assert.match(
    route,
    /syncSourceRegistrationAfterVehicleDelete\(conn, vehicle, req\.session\.admin\.id, reason\)/,
    'vehicle delete route should sync the source registration after soft-deleting the vehicle'
  );
  assert.match(
    route,
    /UPDATE registrations[\s\S]*SET deleted_at = NOW\(\), deleted_by = \?, delete_reason = \?[\s\S]*WHERE id = \? AND deleted_at IS NULL/s,
    'when no active public vehicles remain, the source registration should be soft-deleted instead of staying pending'
  );
  assert.match(
    route,
    /syncRegistrationStatusFromPublicVehicles\(conn, Number\(sourceRegistrationId\), adminId\)/,
    'when another public vehicle remains, the registration status should be recalculated from active vehicles'
  );
});
