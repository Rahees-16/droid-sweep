'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseHierarchy, signature, foregroundPackage } = require('../src/ui');
const { buildPolicy } = require('../src/safety');
const { runChecks, screenLevelChecks } = require('../src/checks');
const { analyseLogcat } = require('../src/logcat');
const { AdbDriver } = require('../src/driver');
const { fixtures } = require('./helpers');

const load = (n) => parseHierarchy(fs.readFileSync(path.join(fixtures, n), 'utf8'));
const checks = (n) => runChecks(load(n), { pkg: 'com.example.demo', density: 420 });

test('parser reads bounds, ids and entities', () => {
  const ui = parseHierarchy(`<hierarchy><node text="a &amp; b" resource-id="x:id/y" class="C" package="p" clickable="true" enabled="true" scrollable="false" bounds="[1,2][30,40]" content-desc=""/></hierarchy>`);
  assert.equal(ui.nodes[0].text, 'a & b');
  assert.deepEqual(ui.nodes[0].bounds, { l: 1, t: 2, r: 30, b: 40 });
});

test('signature is stable across volatile text and scroll, and differs between screens', () => {
  const home = load('home.xml');
  const variant = parseHierarchy(fs.readFileSync(path.join(fixtures, 'home.xml'), 'utf8').replace('Demo Home', 'Demo Home 12:03').replace('Item A', 'Item Q'));
  assert.equal(signature(home, 'A'), signature(variant, 'A'));
  assert.equal(signature(home, 'A'), signature(load('home_scrolled.xml'), 'A'));
  assert.notEqual(signature(home, 'A'), signature(load('profile.xml'), 'A'));
  assert.notEqual(signature(home, 'A'), signature(home, 'B'));
  assert.equal(foregroundPackage(load('external.xml')), 'com.android.chrome');
});

test('denylist matches default words, tokens only, and descendants', () => {
  const p = buildPolicy();
  const ui = load('home.xml');
  const byId = (id) => ui.nodes.find((n) => n.resourceId.endsWith('/' + id));
  assert.equal(p.match(byId('btn_delete_all')), 'delete');
  assert.equal(p.match(byId('btn_profile')), null);
  const s = load('settings.xml');
  assert.equal(p.match(s.nodes.find((n) => n.resourceId.endsWith('btn_reset'))), 'reset');
  assert.equal(p.match(load('profile.xml').nodes.find((n) => n.resourceId.endsWith('btn_logout'))), 'logout');
  for (const k of ['logout', 'log out', 'sign out', 'pay', 'buy', 'purchase', 'subscribe', 'order', 'send', 'post', 'publish', 'submit', 'confirm', 'transfer', 'uninstall', 'factory', 'wipe', 'call', 'dial', 'share', 'erase', 'clear', 'remove']) {
    assert.ok(p.keywords.includes(k), k);
  }
});

test('--deny extends and --allow relaxes', () => {
  const ui = load('home.xml');
  const prof = ui.nodes.find((n) => n.resourceId.endsWith('btn_profile'));
  const del = ui.nodes.find((n) => n.resourceId.endsWith('btn_delete_all'));
  assert.equal(buildPolicy({ deny: ['profile'] }).match(prof), 'profile');
  assert.equal(buildPolicy({ allow: ['delete'] }).match(del), null);
});

test('check: missing label', () => {
  const f = checks('home.xml').filter((x) => x.type === 'missing-label');
  assert.equal(f.length, 1);
  assert.match(f[0].selector, /iv_menu/);
});

test('check: 19dp touch target', () => {
  const f = checks('profile.xml').filter((x) => x.type === 'small-touch-target');
  assert.equal(f.length, 1);
  assert.match(f[0].selector, /btn_edit_small/);
  assert.match(f[0].message, /20x20dp|19x19dp/);
  assert.equal(checks('home.xml').filter((x) => x.type === 'small-touch-target').length, 0);
});

test('check: off-screen element, overlap, duplicate ids', () => {
  const c = checks('settings.xml');
  assert.ok(c.some((x) => x.type === 'off-screen' && /btn_advanced/.test(x.selector)));
  assert.ok(c.some((x) => x.type === 'overlapping-clickables'));
  assert.ok(c.some((x) => x.type === 'duplicate-id' && /btn_option/.test(x.selector)));
});

test('check: dead end and empty screens', () => {
  const dead = screenLevelChecks(load('help.xml'), { pkg: 'com.example.demo', actionable: 0, denied: 0 });
  assert.equal(dead[0].type, 'dead-end');
  assert.deepEqual(screenLevelChecks(load('help.xml'), { pkg: 'com.example.demo', actionable: 0, denied: 1 }), []);
  const empty = screenLevelChecks(parseHierarchy('<hierarchy><node class="android.widget.FrameLayout" package="com.example.demo" bounds="[0,0][10,10]" enabled="true"/></hierarchy>'), { pkg: 'com.example.demo', actionable: 0, denied: 0 });
  assert.equal(empty[0].type, 'empty-screen');
});

test('logcat: crash for our package with stack trace; other package ignored', () => {
  const crash = fs.readFileSync(path.join(fixtures, 'logcat_crash.txt'), 'utf8');
  const r = analyseLogcat(crash, { pkg: 'com.example.demo', pid: 4242 });
  assert.equal(r.crashes.length, 1);
  assert.match(r.crashes[0].exception, /NullPointerException/);
  assert.match(r.crashes[0].trace, /SyncActivity\.onCreate/);
  const other = fs.readFileSync(path.join(fixtures, 'logcat_other_crash.txt'), 'utf8');
  assert.equal(analyseLogcat(other, { pkg: 'com.example.demo', pid: 4242 }).crashes.length, 0);
});

test('logcat: ANR, skipped frames, strictmode, deduped errors from our pid only', () => {
  const r = analyseLogcat(fs.readFileSync(path.join(fixtures, 'logcat_noise.txt'), 'utf8'), { pkg: 'com.example.demo', pid: 4242 });
  assert.equal(r.skippedFrames, 87);
  assert.equal(r.strictMode.length, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(r.anrs.length, 1);
});

test('AdbDriver issues expected adb commands and can never type text', async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(' '));
    const cmd = args.join(' ');
    if (cmd.includes('wm density')) return 'Physical density: 440\nOverride density: 420\n';
    if (cmd.includes('dumpsys activity')) return '  topResumedActivity=ActivityRecord{1 u0 com.example.demo/.MainActivity t5}\n';
    if (cmd.includes('uiautomator')) return "<?xml version='1.0'?>\n<hierarchy rotation=\"0\"></hierarchy>\nUI hierarchy dumped to: /dev/tty";
    return '';
  };
  const d = new AdbDriver({ serial: 'emulator-5554', run });
  await d.tap(10.4, 20.6); await d.back(); await d.pressKey(66); await d.scroll('down', { l: 0, t: 0, r: 100, b: 1000 });
  await d.startApp('com.example.demo', null, { forceStop: true }); await d.clearLogcat(); await d.readLogcat();
  assert.equal(await d.density(), 420);
  assert.deepEqual(await d.currentActivity(), { pkg: 'com.example.demo', activity: 'com.example.demo.MainActivity' });
  assert.match(await d.dumpUi(), /<\/hierarchy>$/);
  assert.ok(calls.every((c) => c.startsWith('-s emulator-5554 ')));
  assert.ok(calls.includes('-s emulator-5554 shell input tap 10 21'));
  assert.ok(calls.includes('-s emulator-5554 shell input keyevent 4'));
  assert.ok(calls.includes('-s emulator-5554 shell input swipe 50 750 50 250 300'));
  assert.ok(calls.some((c) => c.includes('logcat -c')) && calls.some((c) => c.includes('logcat -d')));
  assert.ok(!calls.some((c) => /input text|input keyboard/.test(c)));
  assert.equal(typeof d.typeText, 'undefined');
  assert.equal(typeof d.text, 'undefined');
});
