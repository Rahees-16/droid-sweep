'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, makeDriver, fakeClock } = require('./helpers');
const { groupFindings, fileIssues, buildIssue, marker } = require('../src/issues');
const { createGh } = require('../src/gh');
const { main } = require('../src/cli');

function fakeRunner({ issues = [], labels = [] } = {}) {
  const calls = [];
  const runner = async (args, opts) => {
    calls.push({ args, input: opts && opts.input });
    const k = args.slice(0, 2).join(' ');
    if (k === 'issue list') return { code: 0, stdout: JSON.stringify(issues), stderr: '' };
    if (k === 'label list') return { code: 0, stdout: JSON.stringify(labels.map((name) => ({ name }))), stderr: '' };
    if (k === 'issue create') return { code: 0, stdout: `https://example.test/o/r/issues/${calls.length}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}
const mk = (type, severity, screen, sel = 'x') => ({ type, severity, screen, selector: sel, message: 'm', fingerprint: `${type}${screen}${sel}` });
const F = [mk('crash', 'high', 'A'), mk('missing-label', 'medium', 'A'), mk('missing-label', 'medium', 'B'), mk('dead-end', 'low', 'C')];

test('grouping is one issue per (type, severity), highest severity first', () => {
  const g = groupFindings(F, 'com.example.demo');
  assert.equal(g.length, 3);
  assert.equal(g[0].type, 'crash');
  assert.equal(g[1].findings.length, 2);
  const issue = buildIssue(g[1], 'com.example.demo');
  assert.deepEqual(issue.labels, ['droid-sweep', 'severity:medium']);
  assert.ok(issue.body.includes(marker(g[1].key)) && issue.body.includes('`A`') && issue.body.includes('`B`'));
});

test('default is a dry run: prints issues, makes zero gh calls', async () => {
  const { runner, calls } = fakeRunner();
  const lines = [];
  const res = await fileIssues({ repo: 'o/r', findings: F, pkg: 'com.example.demo', gh: createGh(runner), out: (s) => lines.push(s) });
  assert.equal(calls.length, 0);
  assert.equal(res.dryRun, true);
  assert.match(lines.join('\n'), /DRY RUN/);
  assert.match(lines.join('\n'), /Title: \[droid-sweep\] crash/);
  assert.match(lines.join('\n'), /droid-sweep:fingerprint=/);
});

test('--yes creates issues, labels only if missing', async () => {
  const { runner, calls } = fakeRunner({ labels: ['droid-sweep'] });
  const res = await fileIssues({ repo: 'o/r', findings: F, pkg: 'p.q', gh: createGh(runner), yes: true, out: () => {} });
  assert.equal(res.created.length, 3);
  const created = calls.filter((c) => c.args[0] === 'label' && c.args[1] === 'create').map((c) => c.args[2]);
  assert.deepEqual(created.sort(), ['severity:high', 'severity:low', 'severity:medium']);
  assert.equal(calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'create').length, 3);
  assert.ok(calls.every((c) => c.args.includes('-R') || c.args[0] === 'issue' || c.args[0] === 'label'));
});

test('duplicates (marker in an open issue) are not recreated', async () => {
  const g = groupFindings(F, 'p.q')[0];
  const { runner, calls } = fakeRunner({ issues: [{ number: 7, title: 't', body: `x\n${marker(g.key)}\n` }], labels: ['droid-sweep', 'severity:high', 'severity:medium', 'severity:low'] });
  const res = await fileIssues({ repo: 'o/r', findings: F, pkg: 'p.q', gh: createGh(runner), yes: true, out: () => {} });
  assert.equal(res.duplicates.length, 1);
  assert.equal(res.created.length, 2);
  assert.equal(calls.filter((c) => c.args[1] === 'create' && c.args[0] === 'issue').length, 2);
  assert.equal(calls.filter((c) => c.args[0] === 'label' && c.args[1] === 'create').length, 0);
});

test('--max-issues caps the number of issues', async () => {
  const { runner, calls } = fakeRunner();
  const res = await fileIssues({ repo: 'o/r', findings: F, pkg: 'p.q', gh: createGh(runner), yes: true, maxIssues: 1, out: () => {} });
  assert.equal(res.created.length, 1);
  assert.equal(res.capped, 2);
  assert.equal(calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'create').length, 1);
});

test('CLI: --create-issues alone is dry run; --yes without --create-issues is an error', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-iss-'));
  const { runner, calls } = fakeRunner();
  const base = () => ({ driverFactory: async () => ({ driver: makeDriver(), serial: 'emulator-5554' }), clock: fakeClock(), out: () => {}, err: () => {}, env: {}, cwd, ghRunner: runner });
  await main(['com.example.demo', '--i-understand', '--create-issues', 'o/r'], base());
  assert.equal(calls.length, 0);
  assert.equal(await main(['com.example.demo', '--i-understand', '--yes'], base()), 2);
  assert.equal(await main(['com.example.demo', '--i-understand', '--create-issues', 'bad repo'], base()), 2);
  await main(['com.example.demo', '--i-understand', '--create-issues', 'o/r', '--yes', '--max-issues', '2'], base());
  assert.equal(calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'create').length, 2);
});
