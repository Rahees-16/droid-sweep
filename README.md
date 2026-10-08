# droid-sweep

`droid-sweep` automatically explores every reachable screen of an Android app on an emulator
(or device) and verifies each one. It is the Android counterpart of `site-sweep` (a website
crawler) and follows the same conventions: `report.json` + `report.md`, findings with a stable
fingerprint, exit codes, and a dry-run-by-default GitHub issue filer.

> **Status:** the exploration engine, checks, reports and issue filing are covered by tests that
> run against a `FakeDriver` replaying recorded uiautomator XML. The real `AdbDriver` path
> (actual `adb` calls) has **not been exercised on a live emulator or device** yet. Treat the
> first real run as a trial run, on a throwaway emulator.

## Install

Requires Node.js 20+ and `adb` on your `PATH` (or set `ADB=/path/to/adb`). No npm dependencies.

```sh
git clone <this repo> && cd droid-sweep
npm link        # or: node bin/droid-sweep.js ...
```

## Usage

```sh
# preview: launches the app, dumps the first screen, prints what it would tap and skip
droid-sweep com.example.app --dry-run

# real run (requires the confirmation flag or DROID_SWEEP_OK=1)
droid-sweep com.example.app --i-understand --serial emulator-5554 \
  --max-screens 30 --max-actions 100 --max-depth 5 --settle-ms 800

# extend / relax the denylist, save screenshots, file issues (dry run)
droid-sweep com.example.app --i-understand --deny archive --allow share --screenshot \
  --create-issues OWNER/REPO
```

Options: `--activity`, `--serial`, `--max-screens` (30), `--max-actions` (100), `--max-depth` (5),
`--settle-ms` (800), `--slow-ms` (2000), `--max-scrolls` (3), `--frames-threshold` (30),
`--deny`, `--allow`, `--i-understand`, `--allow-physical`, `--dry-run`, `--screenshot`,
`--out DIR` (default `./droid-sweep-out`), `--fail-on high|medium|low|none` (default `high`),
`--create-issues OWNER/REPO`, `--yes`, `--max-issues` (20).

Exit codes: `0` nothing at or above `--fail-on`; `1` findings at or above it; `2` usage or runtime error.

Output in `./droid-sweep-out/`: `report.json`, `report.md`, `graph.json` (screens = nodes, taps = edges),
`graph.md` (Mermaid), and `screens/*.png` with `--screenshot`.

## How it works

The app is launched, the UI hierarchy is dumped (`uiautomator dump`), and a screen signature is
computed from the activity plus the normalized set of resource-ids/classes (volatile text is ignored).
Clickable, enabled elements not yet tried on a screen are tapped depth-first; after each tap the UI is
polled until it stops changing, then `back` returns. Scrollable containers are scrolled a bounded
number of times to reveal more elements. Taps that leave the target package are recorded as
`external-exit` and backed out of. Crashes, ANRs and system "not responding" dialogs trigger a relaunch,
and the tap path is replayed to resume.

## Checks

| type | severity | what |
|---|---|---|
| `missing-label` | medium (low for non-clickable images) | clickable/image element with no content-desc and no text |
| `small-touch-target` | low | clickable target under 48x48dp (bounds and `wm density`) |
| `off-screen` | medium | element bounds extend outside the screen (outside scrollables) |
| `overlapping-clickables` | low | two unrelated clickables overlap by more than half |
| `duplicate-id` | low | duplicate resource-id / content-desc among clickables on one screen |
| `dead-end` | low | no actionable elements (possible dead end) |
| `empty-screen` | medium | nothing visible in the target package |
| `crash` | high | `FATAL EXCEPTION` in logcat for the package, with stack trace |
| `anr` | high | `ANR in <package>` or a system not-responding dialog |
| `skipped-frames` | medium | Choreographer "Skipped N frames" at or above the threshold |
| `strictmode` | low | StrictMode violations from the app process |
| `logcat-error` | low | error-level logcat lines from the app process after a screen |
| `back-exits-app` | high | back press left the app unexpectedly |
| `back-mismatch` | medium | back press did not return to the previous screen |
| `slow-transition` | low/medium | UI took longer than `--slow-ms` to settle |
| `external-exit` | low | a tap left the target package |

## Safety model

This tool taps things. Run it **only against test builds, test accounts and emulators, never
production data or real accounts.** A startup warning says so.

- **Denylist.** Elements whose text, resource-id or content-desc (including their child elements)
  contain any of these words are never tapped: delete, remove, clear, erase, reset, logout, log out,
  sign out, pay, buy, purchase, subscribe, order, send, post, publish, submit, confirm, transfer,
  uninstall, factory, wipe, call, dial, share (plus payment, checkout, signout). Matching is
  case-insensitive on whole words. Extend with `--deny`; relax only with an explicit `--allow`.
  Skipped elements are listed in the report as "Skipped (denylisted)".
- **Never types text.** There is no text-input code path. Text fields are never tapped, and
  checkable toggles/switches are skipped too (reported as `text-input` / `toggle`).
- **Confirmation.** A real run needs `--i-understand` or `DROID_SWEEP_OK=1`. `--dry-run` only dumps
  the first screen.
- **Physical devices** are refused unless `--allow-physical` is given.
- **Hard caps** always apply: at most 500 actions, 100 screens, depth 10, 5 scrolls per container,
  whatever the flags say.
- The denylist is a safety net, not a guarantee. An unlabeled icon button can still do something
  you did not expect, which is why emulators and test accounts are the supported setting.

## Issue creation

`--create-issues OWNER/REPO` files GitHub issues through the `gh` CLI (all `gh` calls live in `src/gh.js`).

- **Default is a dry run**: each issue (title, labels, body) is printed and nothing is created, with no `gh` call at all.
- Real creation requires **both** `--create-issues OWNER/REPO` **and** `--yes`.
- One issue per (type, severity), listing the affected screens. `--max-issues` (default 20) caps the count.
- Each body carries a hidden marker (`<!-- droid-sweep:fingerprint=... -->`); open issues are searched for it
  before creating, and duplicates are skipped.
- Labels `droid-sweep` and `severity:<level>` are created only if missing, and only on real creation.

## Tests

```sh
npm test      # node --test; uses FakeDriver and recorded uiautomator XML fixtures
```

## Limitations

- The real `AdbDriver` has not been run against a live device; only its command construction is unit tested.
- No text input, so screens behind forms or logins are not reached.
- No low-contrast detection (would need screenshot analysis).
- WebViews are opaque: their content does not appear in the hierarchy.
- Screens are identified by structure; two screens with identical ids/classes in one activity merge.
- Screens that animate forever may never "settle"; transition timing is skipped for them.

## License

MIT, see `LICENSE`.
