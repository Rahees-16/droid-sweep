'use strict';
const path = require('path');
const { explore, realClock } = require('./explorer');
const { buildPolicy } = require('./safety');
const { buildReport, buildGraph, writeOutputs, countBySeverity } = require('./report');
const { fileIssues } = require('./issues');
const { createGh } = require('./gh');
const { AdbDriver, listDevices, defaultRun } = require('./driver');
const pkgJson = require('../package.json');

const WARNING = [
  '*** droid-sweep taps through an app automatically. ***',
  'Run it ONLY against test builds, test accounts and emulators - never production data or real accounts.',
  'Elements matching the denylist are never tapped, but the denylist is a safety net, not a guarantee.',
];

const HELP = `droid-sweep <package> [options]

Explore every reachable screen of an Android app and verify it.

  --activity A         launch a specific activity instead of the launcher
  --serial S           adb serial (default: the only connected device)
  --max-screens N      default 30 (hard cap 100)
  --max-actions N      default 100 (hard cap 500)
  --max-depth N        default 5 (hard cap 10)
  --settle-ms N        UI settle poll interval, default 800
  --slow-ms N          slow-transition threshold, default 2000
  --max-scrolls N      scrolls per scrollable container, default 3
  --frames-threshold N skipped-frames threshold, default 30
  --deny a,b           extra denylisted keywords (repeatable)
  --allow a,b          remove keywords from the denylist (explicit relaxation)
  --i-understand       required for a real run (or env DROID_SWEEP_OK=1)
  --allow-physical     permit running on a physical device
  --dry-run            dump the first screen and print what would be tapped
  --screenshot         save a PNG for screens with high-severity findings
  --out DIR            output dir (default ./droid-sweep-out)
  --fail-on LEVEL      high (default) | medium | low | none
  --create-issues O/R  prepare GitHub issues (DRY RUN unless --yes)
  --yes                really create the issues
  --max-issues N       default 20
  --help, --version

Exit codes: 0 nothing at/above --fail-on, 1 findings, 2 usage/error.`;

const VALUE = new Set(['activity', 'serial', 'max-screens', 'max-actions', 'max-depth', 'settle-ms', 'slow-ms', 'max-scrolls', 'frames-threshold', 'deny', 'allow', 'out', 'fail-on', 'create-issues', 'max-issues']);
const BOOL = new Set(['i-understand', 'allow-physical', 'dry-run', 'screenshot', 'yes', 'help', 'version']);
const INTS = ['max-screens', 'max-actions', 'max-depth', 'settle-ms', 'slow-ms', 'max-scrolls', 'frames-threshold', 'max-issues'];

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { _: [], deny: [], allow: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    let [name, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOL.has(name)) { o[name] = true; continue; }
    if (!VALUE.has(name)) throw new UsageError(`Unknown option --${name}`);
    const v = inline !== undefined ? inline : argv[++i];
    if (v === undefined) throw new UsageError(`--${name} needs a value`);
    if (name === 'deny' || name === 'allow') o[name].push(v); else o[name] = v;
  }
  for (const k of INTS) {
    if (o[k] === undefined) continue;
    if (!/^\d+$/.test(o[k])) throw new UsageError(`--${k} must be a non-negative integer`);
    o[k] = Number(o[k]);
  }
  if (o['fail-on'] && !['high', 'medium', 'low', 'none'].includes(o['fail-on'])) throw new UsageError('--fail-on must be high, medium, low or none');
  if (o['create-issues'] && !/^[\w.-]+\/[\w.-]+$/.test(o['create-issues'])) throw new UsageError('--create-issues expects OWNER/REPO');
  if (o.activity && !/^[\w.$/]+$/.test(o.activity)) throw new UsageError('invalid --activity');
  if (o.serial && !/^[\w.:-]+$/.test(o.serial)) throw new UsageError('invalid --serial');
  return o;
}

async function defaultDriverFactory({ serial }) {
  if (!serial) {
    const devs = await listDevices(defaultRun);
    if (devs.length !== 1) throw new UsageError(devs.length ? `Several devices connected (${devs.join(', ')}); pass --serial` : 'No adb device found; start an emulator first');
    serial = devs[0];
  }
  return { driver: new AdbDriver({ serial }), serial };
}

async function main(argv, deps = {}) {
  const out = deps.out || ((s) => process.stdout.write(s + '\n'));
  const err = deps.err || ((s) => process.stderr.write(s + '\n'));
  const env = deps.env || process.env;
  const clock = deps.clock || realClock;
  try {
    const a = parseArgs(argv);
    if (a.help) { out(HELP); return 0; }
    if (a.version) { out(pkgJson.version); return 0; }
    if (a._.length !== 1) throw new UsageError('Expected exactly one <package> argument (see --help)');
    const pkg = a._[0];
    if (!/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(pkg)) throw new UsageError(`Invalid package name: ${pkg}`);
    if (a.yes && !a['create-issues']) throw new UsageError('--yes only makes sense together with --create-issues OWNER/REPO');

    for (const l of WARNING) err(l);
    const ok = a['i-understand'] || env.DROID_SWEEP_OK === '1';
    if (!a['dry-run'] && !ok) throw new UsageError('Refusing to run: pass --i-understand (or set DROID_SWEEP_OK=1) to confirm this is a test build/emulator. Use --dry-run to preview.');

    const { driver, serial } = await (deps.driverFactory || defaultDriverFactory)({ serial: a.serial });
    if (!(await driver.isEmulator()) && !a['allow-physical']) {
      throw new UsageError(`Device ${serial || ''} looks like a physical device. Refusing; use an emulator or pass --allow-physical.`);
    }

    const policy = buildPolicy({ deny: a.deny, allow: a.allow });
    if (a.allow.length) err(`WARNING: denylist relaxed by --allow: ${a.allow.join(',')}`);
    const outDir = path.resolve(deps.cwd || process.cwd(), a.out || 'droid-sweep-out');
    const params = { pkg, activity: a.activity, maxScreens: a['max-screens'], maxActions: a['max-actions'], maxDepth: a['max-depth'],
      settleMs: a['settle-ms'], slowMs: a['slow-ms'], maxScrolls: a['max-scrolls'], framesThreshold: a['frames-threshold'],
      policy, screenshot: a.screenshot, outDir, dryRun: a['dry-run'] };

    const startedAt = new Date().toISOString();
    const result = await explore(driver, params, { clock, log: (m) => err(`  ${m}`) });

    if (a['dry-run']) {
      const s = result.screens[0];
      out(`Dry run: first screen ${s.id}. Would tap ${s.elements.length} element(s):`);
      for (const e of s.elements) out(`  tap ${e.selector} "${e.label}"${e.scrollCount ? ` (after ${e.scrollCount} scroll(s))` : ''}`);
      out(`Would skip ${result.skipped.length} element(s):`);
      for (const k of result.skipped) out(`  skip ${k.selector} "${k.label}" (${k.reason}${k.keyword ? `: ${k.keyword}` : ''})`);
      return 0;
    }

    const rep = buildReport(result, params, { version: pkgJson.version, startedAt, finishedAt: new Date().toISOString() });
    writeOutputs(outDir, rep, buildGraph(result));
    const c = countBySeverity(rep.findings);
    out(`droid-sweep: ${rep.summary.screens} screen(s), ${rep.summary.actions} action(s), ${rep.findings.length} finding(s) (high ${c.high}, medium ${c.medium}, low ${c.low}). Output: ${path.relative(deps.cwd || process.cwd(), outDir) || '.'}`);

    if (a['create-issues']) {
      const gh = deps.gh || createGh(deps.ghRunner);
      await fileIssues({ repo: a['create-issues'], findings: rep.findings, pkg, gh, yes: !!a.yes, maxIssues: a['max-issues'] === undefined ? 20 : a['max-issues'], out });
    }

    const failOn = a['fail-on'] || 'high';
    const rank = { high: 3, medium: 2, low: 1 };
    if (failOn === 'none') return 0;
    return rep.findings.some((f) => rank[f.severity] >= rank[failOn]) ? 1 : 0;
  } catch (e) {
    if (e instanceof UsageError) { err(`error: ${e.message}`); return 2; }
    err(`error: ${e.message}`);
    return 2;
  }
}

module.exports = { main, parseArgs, UsageError, WARNING };
