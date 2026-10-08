'use strict';
const crypto = require('crypto');
const path = require('path');
const U = require('./ui');
const { runChecks, screenLevelChecks } = require('./checks');
const { analyseLogcat } = require('./logcat');

const HARD = { maxActions: 500, maxScreens: 100, maxDepth: 10, maxScrolls: 5 };
const SEV = { high: 3, medium: 2, low: 1 };

const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

function fingerprint(...parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

function clampOpts(o) {
  const c = (v, d, hard) => Math.max(0, Math.min(Number.isFinite(v) ? v : d, hard));
  return {
    pkg: o.pkg, activity: o.activity,
    maxScreens: c(o.maxScreens, 30, HARD.maxScreens),
    maxActions: c(o.maxActions, 100, HARD.maxActions),
    maxDepth: c(o.maxDepth, 5, HARD.maxDepth),
    maxScrolls: c(o.maxScrolls, 3, HARD.maxScrolls),
    settleMs: Number.isFinite(o.settleMs) ? o.settleMs : 800,
    slowMs: Number.isFinite(o.slowMs) ? o.slowMs : 2000,
    framesThreshold: Number.isFinite(o.framesThreshold) ? o.framesThreshold : 30,
    policy: o.policy, screenshot: !!o.screenshot, outDir: o.outDir || 'droid-sweep-out', dryRun: !!o.dryRun,
  };
}

async function explore(driver, rawOpts, { clock = realClock, log = () => {} } = {}) {
  const o = clampOpts(rawOpts);
  const pkg = o.pkg;
  const density = await driver.density();
  const screens = new Map();     // sig -> screen
  const edges = [];
  const findings = new Map();    // fingerprint -> finding
  const skipped = [];
  const skippedSeen = new Set();
  const externalExits = [];
  const stats = { actions: 0, relaunches: 0, backs: 0 };
  let shotCount = 0;

  async function observe() {
    const t0 = clock.now();
    let prevHash = null, prevT = t0, ui = null, xml = null, settled = false, ms = 0;
    for (let i = 0; i < 6; i++) {
      await clock.sleep(o.settleMs);
      xml = await driver.dumpUi();
      ui = U.parseHierarchy(xml);
      const hsh = U.settleHash(ui);
      if (hsh === prevHash) { settled = true; ms = prevT - t0; break; }
      prevHash = hsh; prevT = clock.now();
    }
    const act = await driver.currentActivity();
    const fg = U.foregroundPackage(ui);
    const activity = act ? act.activity : '';
    return { ui, xml, settled, ms, pkg: fg, activity, sig: U.signature(ui, fg === pkg ? activity : fg) };
  }

  function screenIdOf(activity, sig) {
    const short = (activity || 'Screen').split('.').pop().replace(/\W/g, '') || 'Screen';
    return `${short}-${sig.slice(0, 6)}`;
  }

  async function addFinding(screen, f, extra = {}) {
    const fp = f.fingerprint || fingerprint(f.type, pkg, screen.sig, f.selector);
    if (findings.has(fp)) return;
    const finding = { type: f.type, severity: f.severity, screen: screen.id, selector: f.selector, message: f.message, fingerprint: fp, ...extra };
    if (o.screenshot && f.severity === 'high' && shotCount < 50) {
      const rel = path.join('screens', `${screen.id}-${f.type}.png`);
      try { await driver.screenshot(path.join(o.outDir, rel)); finding.screenshot = rel; shotCount++; } catch { /* best effort */ }
    }
    findings.set(fp, finding);
  }

  function collectElements(ui) {
    const out = [];
    const counts = new Map();
    for (const n of ui.nodes) {
      if (n.pkg !== pkg || !n.clickable || !n.enabled || U.w(n) <= 0 || U.h(n) <= 0 || n.password) continue;
      const base = `${n.resourceId}|${n.cls}|${n.desc}|${n.text}|${U.humanLabel(n)}`;
      const c = counts.get(base) || 0;
      counts.set(base, c + 1);
      out.push({ key: `${base}#${c}`, node: n });
    }
    return out;
  }

  // Register elements of a dump on the screen, applying the safety policy.
  function mergeElements(screen, ui, scrollCount, scrollBounds) {
    let added = 0;
    for (const el of collectElements(ui)) {
      if (screen.known.has(el.key)) continue;
      screen.known.add(el.key);
      const n = el.node;
      let reason = null, keyword = null;
      if (U.isTextInput(n)) reason = 'text-input';
      else if (n.checkable) reason = 'toggle';
      else { keyword = o.policy.match(n); if (keyword) reason = 'denylisted'; }
      if (reason) {
        const sk = `${screen.id}|${el.key}`;
        if (!skippedSeen.has(sk)) {
          skippedSeen.add(sk);
          skipped.push({ screen: screen.id, selector: U.selectorOf(n), label: U.humanLabel(n), reason, keyword });
        }
        screen.denied++;
        continue;
      }
      screen.elements.push({ key: el.key, selector: U.selectorOf(n), label: U.humanLabel(n), scrollCount, scrollBounds, pos: U.center(n) });
      added++;
    }
    return added;
  }

  async function ensureTop(screen) {
    if (!screen.scrollBounds) return;
    for (let i = 0; i < screen.scrollsDone; i++) await driver.scroll('up', screen.scrollBounds);
  }

  async function register(obs, depth, path_) {
    const id = screenIdOf(obs.activity, obs.sig);
    const screen = { id, sig: obs.sig, activity: obs.activity, depth, path: path_, elements: [], known: new Set(), denied: 0,
      tried: new Set(), scrollBounds: null, scrollsDone: 0, transitionMs: obs.ms };
    screens.set(obs.sig, screen);
    mergeElements(screen, obs.ui, 0, null);
    for (const f of runChecks(obs.ui, { pkg, density })) await addFinding(screen, f);
    // scroll probing
    const sc = obs.ui.nodes.find((n) => n.pkg === pkg && n.scrollable && U.h(n) > 0);
    if (sc && o.maxScrolls > 0) {
      screen.scrollBounds = sc.bounds;
      let lastHash = U.settleHash(obs.ui);
      for (let k = 1; k <= o.maxScrolls; k++) {
        await driver.scroll('down', sc.bounds);
        await clock.sleep(o.settleMs);
        const ui2 = U.parseHierarchy(await driver.dumpUi());
        const h2 = U.settleHash(ui2);
        if (h2 === lastHash) break;
        lastHash = h2;
        screen.scrollsDone = k;
        mergeElements(screen, ui2, k, sc.bounds);
        for (const f of runChecks(ui2, { pkg, density })) await addFinding(screen, f);
      }
      await ensureTop(screen);
    }
    for (const f of screenLevelChecks(obs.ui, { pkg, actionable: screen.elements.length, denied: screen.denied })) await addFinding(screen, f);
    if (obs.settled && obs.ms > o.slowMs) {
      await addFinding(screen, { type: 'slow-transition', severity: obs.ms > o.slowMs * 2 ? 'medium' : 'low', selector: '(transition)',
        message: `Screen took ${obs.ms}ms to settle (threshold ${o.slowMs}ms)` });
    }
    log(`screen ${id} (${screen.elements.length} actionable)`);
    return screen;
  }

  async function checkLog(screen, context) {
    const text = await driver.readLogcat();
    await driver.clearLogcat();
    const pid = await driver.pid(pkg);
    const r = analyseLogcat(text, { pkg, pid });
    let crashed = false, anr = false;
    for (const c of r.crashes) {
      crashed = true;
      await addFinding(screen, { type: 'crash', severity: 'high', selector: context,
        message: `FATAL EXCEPTION: ${c.exception}\n${c.trace}`,
        fingerprint: fingerprint('crash', pkg, c.exception, (c.trace.split('\n')[1] || '').trim()) });
    }
    for (const a of r.anrs) {
      anr = true;
      await addFinding(screen, { type: 'anr', severity: 'high', selector: context, message: a.message });
    }
    if (r.skippedFrames >= o.framesThreshold) {
      await addFinding(screen, { type: 'skipped-frames', severity: 'medium', selector: '(logcat)',
        message: `Choreographer skipped ${r.skippedFrames} frames (threshold ${o.framesThreshold})` });
    }
    for (const s of r.strictMode) await addFinding(screen, { type: 'strictmode', severity: 'low', selector: '(logcat)', message: `StrictMode: ${s}` });
    for (const e of r.errors) await addFinding(screen, { type: 'logcat-error', severity: 'low', selector: `${e.tag}`, message: `${e.tag}: ${e.msg}` });
    return { crashed, anr };
  }

  async function launch() {
    stats.relaunches++;
    await driver.startApp(pkg, o.activity, { forceStop: true });
    await driver.clearLogcat();
  }

  async function doTap(step) {
    if (stats.actions >= o.maxActions) return false;
    stats.actions++;
    if (step.scrollCount) {
      for (let i = 0; i < step.scrollCount; i++) await driver.scroll('down', step.scrollBounds);
      await clock.sleep(o.settleMs);
    }
    await driver.tap(step.x, step.y);
    return true;
  }

  // Relaunch and replay a tap path; true if we end on the expected screen.
  async function recoverTo(pathSteps, expectSig) {
    await launch();
    let obs = await observe();
    for (const step of pathSteps) {
      if (!(await doTap(step))) return false;
      obs = await observe();
    }
    return obs.pkg === pkg && obs.sig === expectSig;
  }

  async function visit(screen) {
    for (;;) {
      if (stats.actions >= o.maxActions) return 'ok';
      const el = screen.elements.find((e) => !screen.tried.has(e.key));
      if (!el) return 'ok';
      screen.tried.add(el.key);

      let pos = el.pos;
      await ensureTop(screen);
      if (el.scrollCount) {
        for (let i = 0; i < el.scrollCount; i++) await driver.scroll('down', el.scrollBounds);
        await clock.sleep(o.settleMs);
        const ui = U.parseHierarchy(await driver.dumpUi());
        const found = collectElements(ui).find((e) => e.key === el.key);
        if (!found) continue;
        pos = U.center(found.node);
        // scroll position is part of the replay step
      }
      const step = { x: pos.x, y: pos.y, scrollCount: el.scrollCount, scrollBounds: el.scrollBounds };
      // Perform the tap (scrolling already applied above, so no extra scrolling here)
      if (stats.actions >= o.maxActions) return 'ok';
      stats.actions++;
      await driver.tap(pos.x, pos.y);
      const obs = await observe();
      const attribution = obs.pkg === pkg && screens.get(obs.sig) ? screens.get(obs.sig) : screen;
      const lg = await checkLog(attribution, el.selector);
      const childPath = [...screen.path, step];

      if (lg.crashed || lg.anr || /isn'?t responding|keeps stopping|has stopped/i.test(obs.ui.nodes.map((n) => n.text).join(' '))) {
        if (!lg.crashed && !lg.anr) {
          await addFinding(screen, { type: 'anr', severity: 'high', selector: el.selector, message: 'System dialog reports the app is not responding / has stopped' });
        }
        if (!(await recoverTo(screen.path, screen.sig))) return 'lost';
        continue;
      }

      if (obs.pkg !== pkg) {
        externalExits.push({ from: screen.id, via: el.selector, label: el.label, pkg: obs.pkg, activity: obs.activity });
        edges.push({ from: screen.id, to: `external:${obs.pkg || 'unknown'}`, via: el.label || el.selector, kind: 'external-exit' });
        await addFinding(screen, { type: 'external-exit', severity: 'low', selector: el.selector,
          message: `Tapping leaves the app (now in ${obs.pkg || 'unknown package'})` });
        await driver.back();
        const after = await observe();
        await checkLog(screen, 'back');
        if (!(after.pkg === pkg && after.sig === screen.sig) && !(await recoverTo(screen.path, screen.sig))) return 'lost';
        continue;
      }

      if (obs.sig === screen.sig) continue; // no visible navigation

      let dest = screens.get(obs.sig);
      const isNew = !dest;
      if (isNew && screens.size < o.maxScreens) dest = await register(obs, screen.depth + 1, childPath);
      if (dest) {
        edges.push({ from: screen.id, to: dest.id, via: el.label || el.selector, kind: 'tap' });
        if (isNew && screen.depth + 1 < o.maxDepth) {
          const r = await visit(dest);
          if (r === 'lost') { if (!(await recoverTo(screen.path, screen.sig))) return 'lost'; continue; }
        }
      }
      // go back to this screen
      stats.backs++;
      await driver.back();
      const bk = await observe();
      await checkLog(screen, 'back');
      if (bk.pkg === pkg && bk.sig === screen.sig) continue;
      const from = dest || { id: obs.activity || 'unknown', sig: obs.sig };
      if (bk.pkg !== pkg) {
        await addFinding(from.sig === screen.sig ? screen : (screens.get(from.sig) || screen), { type: 'back-exits-app', severity: 'high', selector: '(back)',
          message: `Pressing back from ${from.id} left the app instead of returning to ${screen.id}` });
      } else {
        await addFinding(screens.get(from.sig) || screen, { type: 'back-mismatch', severity: 'medium', selector: '(back)',
          message: `Pressing back from ${from.id} did not return to ${screen.id}` });
      }
      if (!(await recoverTo(screen.path, screen.sig))) return 'lost';
    }
  }

  // ---- run ----
  await driver.clearLogcat();
  await driver.startApp(pkg, o.activity, { forceStop: false });
  const first = await observe();
  if (first.pkg !== pkg) throw new Error(`App ${pkg} did not come to the foreground (saw ${first.pkg || 'nothing'})`);
  const root = await register(first, 0, []);
  if (o.dryRun) {
    return { root: root.id, screens: [...screens.values()], edges, findings: [...findings.values()], skipped, externalExits, stats, dryRun: true };
  }
  await checkLog(root, 'launch');
  if (o.maxDepth > 0) await visit(root);
  return { root: root.id, screens: [...screens.values()], edges, findings: [...findings.values()], skipped, externalExits, stats };
}

module.exports = { explore, HARD, SEV, fingerprint, realClock };
