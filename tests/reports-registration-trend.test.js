const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('reports route prepares a 30-day registration trend for the summary view', () => {
  const route = readProjectFile('routes/reports.js');

  assert.match(
    route,
    /function buildRegistrationTrend\(rows, today = new Date\(\)\)/,
    'route should normalize sparse daily registration rows into a full trend series'
  );
  assert.match(
    route,
    /DATE_FORMAT\(registered_at, '%Y-%m-%d'\) AS date_key/,
    'route should group registrations by day for the trend query'
  );
  assert.match(
    route,
    /return \{ isSummary: true, regCounts, vioCounts, topProv, registrationTrend \};/,
    'summary report should expose registrationTrend to the EJS view'
  );
});

test('reports summary renders the registration trend chart above the summary tables', () => {
  const template = readProjectFile('views/reports/index.ejs');

  assert.match(
    template,
    /summaryData\.registrationTrend/,
    'summary view should read registrationTrend from route data'
  );
  assert.match(
    template,
    /class="registration-trend-card"[\s\S]*aria-label="กราฟเส้นการลงทะเบียนย้อนหลัง 1 เดือน"[\s\S]*<polyline/,
    'summary view should render an accessible SVG line chart'
  );
  assert.match(
    template,
    /class="registration-trend-card"[\s\S]*<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">/,
    'registration trend chart should appear before the registration and violation summary tables'
  );
});
