'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { parseHierarchy } = require('./ui');

/**
 * AdbDriver interface (duck-typed). Deliberately has NO way to type text.
 *   dumpUi() -> xml string
 *   tap(x, y)
 *   back()
 *   pressKey(keycode)
 *   scroll('down'|'up', bounds)   // 'down' = reveal content further down
 *   screenshot(filePath)
 *   startApp(pkg, activity?, {forceStop?})
 *   currentActivity() -> {pkg, activity} | null
 *   clearLogcat()
 *   readLogcat() -> string
 *   pid(pkg) -> number | null
 *   density() -> number
 *   isEmulator() -> boolean
 */

function defaultRun(args, { binary = false, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.env.ADB || 'adb', args, { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024, timeout },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`adb ${args.join(' ')} failed: ${err.message}${stderr ? ` ${String(stderr).slice(0, 200)}` : ''}`));
        resolve(stdout);
      });
  });
}

class AdbDriver {
  constructor({ serial, run = defaultRun } = {}) {
    this.serial = serial;
    this.run = run;
  }
  _adb(args, opts) { return this.run(['-s', this.serial, ...args], opts); }
  shell(cmd) { return this._adb(['shell', cmd]); }

  async dumpUi() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const out = String(await this._adb(['exec-out', 'uiautomator', 'dump', '/dev/tty']));
        const s = out.indexOf('<?xml'), e = out.lastIndexOf('</hierarchy>');
        if (s >= 0 && e > s) return out.slice(s, e + '</hierarchy>'.length);
      } catch (err) { if (attempt === 2) throw err; }
    }
    throw new Error('uiautomator dump returned no hierarchy');
  }
  async tap(x, y) { await this.shell(`input tap ${Math.round(x)} ${Math.round(y)}`); }
  async pressKey(code) { await this.shell(`input keyevent ${Number(code)}`); }
  async back() { await this.pressKey(4); }
  async scroll(dir, b) {
    const x = Math.round((b.l + b.r) / 2);
    const span = b.b - b.t;
    const hi = Math.round(b.t + span * 0.75), lo = Math.round(b.t + span * 0.25);
    const [y1, y2] = dir === 'down' ? [hi, lo] : [lo, hi];
    await this.shell(`input swipe ${x} ${y1} ${x} ${y2} 300`);
  }
  async screenshot(filePath) {
    const buf = await this._adb(['exec-out', 'screencap', '-p'], { binary: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buf);
  }
  async startApp(pkg, activity, { forceStop = false } = {}) {
    if (forceStop) await this.shell(`am force-stop ${pkg}`);
    if (activity) {
      const comp = activity.includes('/') ? activity : `${pkg}/${activity.startsWith('.') ? activity : activity}`;
      await this.shell(`am start -n ${comp}`);
    } else {
      await this.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
    }
  }
  async currentActivity() {
    const out = String(await this.shell('dumpsys activity activities'));
    const m = /(?:topResumedActivity|mResumedActivity)[^\n]*?\s([\w.]+)\/([\w.$]+)/.exec(out);
    if (!m) return null;
    return { pkg: m[1], activity: m[2].startsWith('.') ? m[1] + m[2] : m[2] };
  }
  async clearLogcat() { await this._adb(['logcat', '-c']); }
  async readLogcat() { return String(await this._adb(['logcat', '-d', '-v', 'threadtime'], { timeout: 60000 })); }
  async pid(pkg) {
    try {
      const out = String(await this.shell(`pidof ${pkg}`)).trim().split(/\s+/)[0];
      return /^\d+$/.test(out) ? +out : null;
    } catch { return null; }
  }
  async density() {
    const out = String(await this.shell('wm density'));
    const o = /Override density:\s*(\d+)/.exec(out), p = /Physical density:\s*(\d+)/.exec(out);
    return o ? +o[1] : p ? +p[1] : 420;
  }
  async isEmulator() {
    if (String(this.serial).startsWith('emulator-')) return true;
    try { return String(await this.shell('getprop ro.kernel.qemu')).trim() === '1'; } catch { return false; }
  }
}

async function listDevices(run = defaultRun) {
  const out = String(await run(['devices']));
  return out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2 && p[1] === 'device').map((p) => p[0]);
}

/**
 * FakeDriver: replays recorded hierarchy XML as a state machine.
 * spec = { package, density, start, launcher, emulator, screens: { name: {
 *   xml, activity, pkg?, taps: {idOrTextOrDesc: targetScreen}, scrollXml?: [..],
 *   loadingXml?: [files, each differing], unstableDumps?, logcat?, crash?: logcatText, backTo?: name|'exit' } } }
 */
class FakeDriver {
  constructor(spec, { fixturesDir } = {}) {
    this.spec = spec;
    this.dir = fixturesDir || path.join(__dirname, '..', 'tests', 'fixtures');
    this.log = [];
    this.tapped = [];          // matched keys of tapped elements
    this.rawTaps = [];
    this.shots = [];
    this.current = null;
    this.stack = [];
    this.exited = false;
    this.scrollPos = 0;
    this.pending = 0;
    this.logBuf = '';
    this._cache = {};
  }
  _xml(name) { return (this._cache[name] ||= fs.readFileSync(path.join(this.dir, name), 'utf8')); }
  _screen() { return this.spec.screens[this.current]; }
  _enter(name) {
    this.current = name;
    this.scrollPos = 0;
    const s = this._screen();
    this.pending = s.unstableDumps || 0;
    if (s.logcat) this.logBuf += s.logcat + '\n';
    if (s.crash) { this.logBuf += this._xml(s.crash) + '\n'; this.exited = true; this.stack = []; }
  }
  async startApp(pkg, activity, { forceStop } = {}) {
    this.log.push(`start ${pkg}${forceStop ? ' force' : ''}`);
    this.exited = false;
    this.stack = [];
    this._enter(this.spec.start);
    this.stack.push(this.spec.start);
  }
  async dumpUi() {
    this.log.push('dump');
    if (this.exited) return this._xml(this.spec.launcher);
    const s = this._screen();
    if (this.pending > 0 && s.loadingXml) { this.pending--; return this._xml(s.loadingXml[this.pending % s.loadingXml.length]); }
    if (this.scrollPos > 0 && s.scrollXml) return this._xml(s.scrollXml[this.scrollPos - 1]);
    return this._xml(s.xml);
  }
  async currentActivity() {
    if (this.exited) return { pkg: 'com.android.launcher3', activity: 'com.android.launcher3.Launcher' };
    const s = this._screen();
    return { pkg: s.pkg || this.spec.package, activity: s.activity };
  }
  async tap(x, y) {
    this.log.push(`tap ${x},${y}`);
    this.rawTaps.push([x, y]);
    if (this.exited) return;
    const ui = parseHierarchy(await this.dumpUi());
    let hit = null, area = Infinity;
    for (const n of ui.nodes) {
      const b = n.bounds;
      if (x >= b.l && x < b.r && y >= b.t && y < b.b && n.clickable) {
        const a = (b.r - b.l) * (b.b - b.t);
        if (a < area) { hit = n; area = a; }
      }
    }
    if (!hit) return;
    const kids = [];
    (function walk(n) { for (const c of n.children) { kids.push(c.text, c.desc); walk(c); } })(hit);
    const keys = [hit.resourceId.split('/').pop(), hit.text, hit.desc, ...kids].filter(Boolean);
    this.tapped.push(keys[0] || hit.cls);
    const taps = this._screen().taps || {};
    for (const k of keys) {
      if (taps[k]) {
        if (taps[k] === 'self') return;
        this.stack.push(taps[k]);
        this._enter(taps[k]);
        return;
      }
    }
  }
  async pressKey(code) { if (Number(code) === 4) return this.back(); this.log.push(`key ${code}`); }
  async back() {
    this.log.push('back');
    if (this.exited) return;
    const s = this._screen();
    if (s.backTo) {
      if (s.backTo === 'exit') { this.exited = true; return; }
      this.stack.pop(); this.stack.push(s.backTo); this._enter(s.backTo); return;
    }
    this.stack.pop();
    if (!this.stack.length) { this.exited = true; return; }
    this._enter(this.stack[this.stack.length - 1]);
  }
  async scroll(dir) {
    this.log.push(`scroll ${dir}`);
    if (this.exited) return;
    const n = (this._screen().scrollXml || []).length;
    this.scrollPos = dir === 'down' ? Math.min(n, this.scrollPos + 1) : Math.max(0, this.scrollPos - 1);
  }
  async screenshot(file) { this.shots.push(file); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'PNG'); }
  async clearLogcat() { this.logBuf = ''; }
  async readLogcat() { return this.logBuf; }
  async pid() { return 4242; }
  async density() { return this.spec.density || 420; }
  async isEmulator() { return this.spec.emulator !== false; }
}

module.exports = { AdbDriver, FakeDriver, listDevices, defaultRun };
