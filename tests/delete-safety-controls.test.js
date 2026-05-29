const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('system users cannot be permanently deleted from the users page', () => {
  const route = readProjectFile('routes/users.js');
  const template = readProjectFile('views/users/index.ejs');

  assert.doesNotMatch(
    route,
    /DELETE FROM admins/i,
    'users route should not hard-delete admin accounts'
  );
  assert.match(
    route,
    /router\.post\('\/:id\/delete'[\s\S]*res\.redirect\('\/users'\)/,
    'legacy delete endpoint should be kept non-destructive for direct POSTs'
  );
  assert.doesNotMatch(
    template,
    /action="\/users\/<%= u\.id %>\/delete"/,
    'users page should not expose a permanent delete form'
  );
});

test('rules and related types can be deleted only when they have no usage', () => {
  const route = readProjectFile('routes/rules.js');
  const template = readProjectFile('views/rules/index.ejs');

  assert.match(
    route,
    /if \(ruleCount > 0\) \{[\s\S]*return res\.redirect\('\/rules\?tab=types'\);[\s\S]*\}[\s\S]*DELETE FROM violation_types WHERE id = \?/,
    'violation types should block deletion when attached to rules and delete only unused rows'
  );
  assert.doesNotMatch(
    route,
    /if \(ruleCount > 0\) \{[\s\S]*UPDATE violation_types SET is_active = 0 WHERE id = \?/,
    'violation type delete should not silently hide used rows'
  );
  assert.match(
    route,
    /if \(ruleCount > 0\) \{[\s\S]*return res\.redirect\('\/rules\?tab=penalties'\);[\s\S]*\}[\s\S]*DELETE FROM penalty_types WHERE id = \?/,
    'penalty types should block deletion when attached to rules and delete only unused rows'
  );
  assert.doesNotMatch(
    route,
    /if \(ruleCount > 0\) \{[\s\S]*UPDATE penalty_types SET is_active = 0 WHERE id = \?/,
    'penalty type delete should not silently hide used rows'
  );
  assert.match(
    route,
    /SELECT COUNT\(\*\) AS cnt FROM violations WHERE rule_id = \?/,
    'rule destroy route should check violation usage before deleting'
  );
  assert.match(
    route,
    /if \(violationCount > 0\) \{[\s\S]*return res\.redirect\('\/rules\?tab=rules'\);[\s\S]*\}[\s\S]*DELETE FROM rules WHERE id = \?/,
    'rules should block deletion when used in violation history and delete only unused rows'
  );
  assert.match(
    template,
    /<% if \(\(r\.violation_count \|\| 0\) === 0\) \{ %>[\s\S]*action="\/rules\/<%= r\.id %>\/destroy"/,
    'rules UI should expose permanent deletion only for unused rules'
  );
  assert.match(
    template,
    /<% if \(\(type\.rule_count \|\| 0\) === 0\) \{ %>[\s\S]*action="\/rules\/types\/<%= type\.id %>\/delete"/,
    'violation type UI should expose deletion only for unused types'
  );
  assert.match(
    template,
    /<% if \(\(type\.rule_count \|\| 0\) === 0\) \{ %>[\s\S]*action="\/rules\/penalties\/<%= type\.id %>\/delete"/,
    'penalty type UI should expose deletion only for unused types'
  );
});

test('deleted summons appointments keep detail-only actions in the deleted tab', () => {
  const route = readProjectFile('routes/reports.js');
  const template = readProjectFile('views/reports/summons.ejs');

  assert.doesNotMatch(
    route,
    /\/summons\/appointments\/:appointmentId\/restore/,
    'summons reports should not expose a restore endpoint for deleted appointments'
  );
  assert.doesNotMatch(
    template,
    /action="\/reports\/summons\/appointments\/<%= item\.id %>\/restore"/,
    'deleted summons tab should not show a restore form'
  );
  assert.doesNotMatch(
    template,
    /data-lucide="rotate-ccw"/,
    'deleted summons tab should not show a restore icon'
  );
});
