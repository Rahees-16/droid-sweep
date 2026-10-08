'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, makeDriver, fakeClock } = require('./helpers');
const { main } = require('../src/cli');
const { buildReport, buildGraph, mermaid } = require('../src/report');
const { buildPolicy } = require('../src/safety');

const ids = (r) => r.result.screens.map((s) => s.id.split('-')[0]);
const types = (r) => r.result.findings.map((f) => f.type);

test('exploration reaches every reachable fixture screen (including after scrolling)', async () => {
  const r = await run({});
  const got = new Set(ids(r));
  for (const s of ['MainActivity', 'ProfileActivity', 'SettingsActivity', 'HelpActivity', 'ReportsActivity', 'MoreActivity']) assert.ok(got.has(s), `missing ${s}`);
  assert.ok(!got.has('DeletedActivity') && !got.has('TypingActivity') && !got.has('LoginActivity'));
});

test('denylisted elements are never tapped and are reported as skipped', async () => {
  const r = await run({});
  for (const k of ['btn_delete_all', 'btn_logout', 'btn_reset']) {
    assert.ok(!r.driver.tapped.includes(k), `${k} was tapped`);
    assert.ok(r.result.skipped.some((s) => s.selector.endsWith(k) && s.reason === 'denylisted'), `${k} not listed`);
  }
  assert.ok(r.result.skipped.some((s) => s.reason === 'toggle'));
  assert.ok(r.result.skipped.some((s) => s.reason === 'text-input'));
  assert.ok(!r.driver.tapped.includes('et_name') && !r.driver.tapped.includes('sw_wifi'));
});

test('--allow relaxes the denylist explicitly', async () => {
  const r = await run({ policy: { allow: ['delete'] } });
  assert.ok(r.driver.tapped.includes('btn_delete_all'));
  assert.ok(!r.driver.tapped.includes('btn_logout'));
});

test('never types text: driver exposes no text API and logs no text input', async () => {
  const r = await run({});
  assert.equal(typeof r.driver.typeText, 'undefined');
  assert.ok(!r.driver.log.some((l) => /text|keyboard/.test(l)));
  assert.ok(r.driver.log.every((l) => /^(tap|back|dump|start|scroll|key)\b/.test(l)));
});

test('caps are respected', async () => {
  let r = await run({ maxActions: 3 });
  assert.ok(r.result.stats.actions <= 3);
  assert.ok(r.driver.rawTaps.length <= 3);
  r = await run({ maxScreens: 2 });
  assert.ok(r.result.screens.length <= 2);
  r = await run({ maxDepth: 1 });
  assert.ok(r.result.screens.every((s) => s.depth <= 1));
  r = await run({ maxActions: 100000 });
  assert.ok(r.result.stats.actions <= 500);
});

test('external exit is recorded, backed out of, and not explored', async () => {
  const r = await run({});
  assert.equal(r.result.externalExits.length, 1);
  assert.equal(r.result.externalExits[0].pkg, 'com.android.chrome');
  assert.ok(types(r).includes('external-exit'));
  assert.ok(!r.result.screens.some((s) => s.activity.includes('chrome')));
});

test('crash from logcat is a high finding with stack trace and the run recovers', async () => {
  const r = await run({});
  const crash = r.result.findings.find((f) => f.type === 'crash');
  assert.ok(crash);
  assert.equal(crash.severity, 'high');
  assert.match(crash.message, /NullPointerException/);
  assert.match(crash.message, /SyncActivity\.onCreate/);
  assert.ok(r.result.stats.relaunches >= 1);
  assert.ok(ids(r).includes('ReportsActivity'), 'continued after the crash');
});

test('planted problems are detected in a full run', async () => {
  const t = types(await run({}));
  for (const x of ['missing-label', 'small-touch-target', 'off-screen', 'overlapping-clickables', 'duplicate-id', 'dead-end', 'slow-transition']) assert.ok(t.includes(x), x);
});

test('slow transition respects --slow-ms', async () => {
  assert.ok(types(await run({ slowMs: 10000 })).every((x) => x !== 'slow-transition'));
});

test('back that exits the app is a high finding', async () => {
  const d = makeDriver({ screens: { help: { ...require('./fixtures/demo-app').screens.help, backTo: 'exit' } } });
  const r = await run({}, d);
  assert.ok(types(r).includes('back-exits-app'));
});

test('back that lands elsewhere is a back-mismatch', async () => {
  const d = makeDriver({ screens: { help: { ...require('./fixtures/demo-app').screens.help, backTo: 'settings' } } });
  const r = await run({}, d);
  assert.ok(types(r).includes('back-mismatch'));
});

test('findings are deterministic with stable unique fingerprints', async () => {
  const a = (await run({})).result.findings.map((f) => f.fingerprint).sort();
  const b = (await run({})).result.findings.map((f) => f.fingerprint).sort();
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
  for (const f of (await run({})).result.findings) assert.match(f.fingerprint, /^[0-9a-f]{16}$/);
});

test('screenshots are saved for high-severity findings only when requested', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
  let r = await run({ screenshot: true, outDir: out });
  assert.ok(r.driver.shots.length >= 1);
  r = await run({ screenshot: false, outDir: out });
  assert.equal(r.driver.shots.length, 0);
});

test('report and graph outputs', async () => {
  const r = await run({});
  const params = { pkg: 'com.example.demo', maxScreens: 30, maxActions: 100, maxDepth: 5, settleMs: 800, slowMs: 2000, policy: buildPolicy() };
  const rep = buildReport(r.result, params);
  assert.equal(rep.summary.findings, rep.findings.length);
  for (const f of rep.findings) for (const k of ['type', 'severity', 'screen', 'selector', 'message', 'fingerprint']) assert.ok(f[k], k);
  const g = buildGraph(r.result);
  assert.ok(g.edges.some((e) => e.kind === 'external-exit'));
  assert.ok(g.nodes.length >= 7);
  const md = mermaid(g);
  assert.match(md, /flowchart TD/);
  assert.match(md, /-->/);
});

test('CLI end to end: files, exit codes, no output outside --out', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cli-'));
  const lines = [];
  const deps = { driverFactory: async () => ({ driver: makeDriver(), serial: 'emulator-5554' }), clock: fakeClock(), out: (s) => lines.push(s), err: () => {}, env: {}, cwd };
  assert.equal(await main(['com.example.demo', '--i-understand'], deps), 1); // crash = high
  for (const f of ['report.json', 'report.md', 'graph.json', 'graph.md']) assert.ok(fs.existsSync(path.join(cwd, 'droid-sweep-out', f)), f);
  deps.driverFactory = async () => ({ driver: makeDriver(), serial: 'emulator-5554' });
  assert.equal(await main(['com.example.demo', '--i-understand', '--fail-on', 'none'], deps), 0);
  deps.driverFactory = async () => ({ driver: makeDriver(), serial: 'emulator-5554' });
  assert.equal(await main(['com.example.demo', '--i-understand', '--fail-on', 'bogus'], deps), 2);
});

test('CLI safety gates: confirm flag, env var, physical device, dry run', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cli-'));
  const mk = (extra = {}) => ({ driverFactory: async () => ({ driver: makeDriver(extra), serial: 'x' }), clock: fakeClock(), out: () => {}, err: () => {}, env: {}, cwd });
  assert.equal(await main(['com.example.demo'], mk()), 2);                                  // no confirmation
  assert.equal(await main(['com.example.demo', '--fail-on', 'none'], { ...mk(), env: { DROID_SWEEP_OK: '1' } }), 0);
  assert.equal(await main(['com.example.demo', '--i-understand'], mk({ emulator: false })), 2); // physical refused
  assert.equal(await main(['com.example.demo', '--i-understand', '--allow-physical', '--fail-on', 'none'], mk({ emulator: false })), 0);
  assert.equal(await main(['com.example.demo', '--dry-run', '--allow-physical'], mk({ emulator: false })), 0);
  assert.equal(await main(['com.example.demo', '--dry-run'], mk({ emulator: false })), 2);      // dry-run still refuses physical
  assert.equal(await main([], mk()), 2);
  assert.equal(await main(['not a package', '--i-understand'], mk()), 2);
  assert.equal(await main(['com.example.demo', '--bogus'], mk()), 2);
});

test('CLI prints the warning and dry run taps nothing', async () => {
  const errs = [], outs = [];
  const d = makeDriver();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cli-'));
  const code = await main(['com.example.demo', '--dry-run'], { driverFactory: async () => ({ driver: d, serial: 'emulator-5554' }), clock: fakeClock(), out: (s) => outs.push(s), err: (s) => errs.push(s), env: {}, cwd });
  assert.equal(code, 0);
  assert.match(errs.join('\n'), /never production data/);
  assert.equal(d.rawTaps.length, 0);
  assert.ok(outs.join('\n').includes('btn_profile'));
  assert.match(outs.join('\n'), /skip .*btn_delete_all/);
  assert.ok(!fs.existsSync(path.join(cwd, 'droid-sweep-out')));
});
