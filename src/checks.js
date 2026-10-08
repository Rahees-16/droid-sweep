'use strict';
const U = require('./ui');

// Per-dump static checks. Returns [{type, severity, selector, message}].
function runChecks(ui, { pkg, density = 420 }) {
  const out = [];
  const mine = ui.nodes.filter((n) => n.pkg === pkg);
  const dp = (px) => px / (density / 160);
  const live = (n) => U.w(n) > 0 && U.h(n) > 0;

  for (const n of mine) {
    if (!live(n)) continue;
    const isImage = /ImageView|ImageButton/.test(n.cls);
    if ((n.clickable || isImage) && !n.text && !n.desc && !U.descendants(n).some((d) => d.text || d.desc)) {
      out.push({ type: 'missing-label', severity: n.clickable ? 'medium' : 'low', selector: U.selectorOf(n),
        message: `${n.clickable ? 'Clickable' : 'Image'} element has no content-description or text` });
    }
    if (n.clickable && n.enabled) {
      const wd = dp(U.w(n)), hd = dp(U.h(n));
      if (wd < 48 || hd < 48) {
        out.push({ type: 'small-touch-target', severity: 'low', selector: U.selectorOf(n),
          message: `Touch target ${wd.toFixed(0)}x${hd.toFixed(0)}dp is smaller than 48x48dp` });
      }
    }
    const b = n.bounds;
    const meaningful = n.text || n.desc || n.clickable;
    if (meaningful && !U.inScrollable(n) && ui.width && ui.height &&
        (b.r > ui.width + 1 || b.b > ui.height + 1 || b.l < -1 || b.t < -1)) {
      out.push({ type: 'off-screen', severity: 'medium', selector: U.selectorOf(n),
        message: `Element bounds [${b.l},${b.t}][${b.r},${b.b}] extend outside the ${ui.width}x${ui.height} screen` });
    }
  }

  const clickables = mine.filter((n) => n.clickable && n.enabled && live(n)).slice(0, 300);
  for (let i = 0; i < clickables.length; i++) {
    for (let j = i + 1; j < clickables.length; j++) {
      const a = clickables[i], c = clickables[j];
      if (U.isAncestor(a, c) || U.isAncestor(c, a)) continue;
      const ix = Math.min(a.bounds.r, c.bounds.r) - Math.max(a.bounds.l, c.bounds.l);
      const iy = Math.min(a.bounds.b, c.bounds.b) - Math.max(a.bounds.t, c.bounds.t);
      if (ix <= 0 || iy <= 0) continue;
      const small = Math.min(U.w(a) * U.h(a), U.w(c) * U.h(c));
      if (ix * iy / small > 0.5) {
        out.push({ type: 'overlapping-clickables', severity: 'low', selector: `${U.selectorOf(a)} <> ${U.selectorOf(c)}`,
          message: 'Two clickable elements overlap by more than half of the smaller one' });
      }
    }
  }

  const fixed = clickables.filter((n) => !U.inScrollable(n));
  for (const [key, label] of [['resourceId', 'resource-id'], ['desc', 'content-desc']]) {
    const groups = new Map();
    for (const n of fixed) if (n[key]) groups.set(n[key], (groups.get(n[key]) || 0) + 1);
    for (const [val, count] of groups) {
      if (count > 1) out.push({ type: 'duplicate-id', severity: 'low', selector: `${label}=${val}`,
        message: `${count} clickable elements share the same ${label} on one screen` });
    }
  }
  return out;
}

// Whole-screen checks, given counts computed by the explorer.
function screenLevelChecks(ui, { pkg, actionable, denied }) {
  const mine = ui.nodes.filter((n) => n.pkg === pkg);
  const meaningful = mine.some((n) => n.text || n.desc || n.clickable || /ImageView|EditText/.test(n.cls));
  if (!meaningful) return [{ type: 'empty-screen', severity: 'medium', selector: '(screen)', message: 'Screen has no visible content' }];
  if (actionable === 0 && denied === 0 && !mine.some((n) => n.scrollable)) {
    return [{ type: 'dead-end', severity: 'low', selector: '(screen)', message: 'Screen has no actionable elements (possible dead end)' }];
  }
  return [];
}

module.exports = { runChecks, screenLevelChecks };
