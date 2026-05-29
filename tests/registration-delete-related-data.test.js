const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('deleting a registration soft-deletes related violation reports, summons, and violations for the same registrant', () => {
  const route = readProjectFile('routes/registrations.js');

  assert.match(
    route,
    /const relatedRegistrationIds = await getRelatedRegistrationIdsForUser\(conn, reg\);/,
    'delete route should collect every registration row tied to the same registrant before deleting related data'
  );
  assert.match(
    route,
    /const relatedRegistrationPlaceholders = sqlPlaceholders\(relatedRegistrationIds\);/,
    'delete route should build placeholders for the related registration ids'
  );
  assert.match(
    route,
    /UPDATE violation_reports[\s\S]*WHERE registration_id IN \(\$\{relatedRegistrationPlaceholders\}\) AND deleted_at IS NULL/s,
    'delete route should remove related rows from violation review'
  );
  assert.match(
    route,
    /UPDATE summons_appointments[\s\S]*WHERE registration_id IN \(\$\{relatedRegistrationPlaceholders\}\) AND deleted_at IS NULL/s,
    'delete route should remove related rows from summons reports'
  );
  assert.match(
    route,
    /UPDATE violations[\s\S]*WHERE registration_id IN \(\$\{relatedRegistrationPlaceholders\}\) AND deleted_at IS NULL/s,
    'delete route should soft-delete related violation history rows'
  );
  assert.match(
    route,
    /UPDATE registrations[\s\S]*WHERE id IN \(\$\{relatedRegistrationPlaceholders\}\) AND deleted_at IS NULL/s,
    'delete route should soft-delete all related registration rows for the registrant'
  );
});

test('restoring a deleted registration restores the same related registration set', () => {
  const route = readProjectFile('routes/registrations.js');

  assert.match(
    route,
    /UPDATE registrations[\s\S]*SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL[\s\S]*WHERE id IN \(\$\{relatedRegistrationPlaceholders\}\)/s,
    'restore route should restore all related registration rows'
  );
  assert.match(
    route,
    /UPDATE violation_reports[\s\S]*SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL[\s\S]*WHERE registration_id IN \(\$\{relatedRegistrationPlaceholders\}\)/s,
    'restore route should restore related violation reports'
  );
  assert.match(
    route,
    /UPDATE summons_appointments[\s\S]*SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL[\s\S]*WHERE registration_id IN \(\$\{relatedRegistrationPlaceholders\}\)/s,
    'restore route should restore related summons appointments'
  );
});
