'use strict';
const crypto = require('crypto');
const { parseXml } = require('./xml');

function parseBounds(s) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(s || '');
  if (!m) return { l: 0, t: 0, r: 0, b: 0 };
  return { l: +m[1], t: +m[2], r: +m[3], b: +m[4] };
}

function parseHierarchy(xml) {
  const doc = parseXml(xml || '');
  const nodes = [];
  const top = [];
  function walk(el, parent, depth) {
    const a = el.attrs;
    const n = {
      idx: nodes.length,
      cls: a.class || '',
      resourceId: a['resource-id'] || '',
      text: a.text || '',
      desc: a['content-desc'] || '',
      pkg: a.package || '',
      clickable: a.clickable === 'true',
      enabled: a.enabled !== 'false',
      scrollable: a.scrollable === 'true',
      checkable: a.checkable === 'true',
      password: a.password === 'true',
      bounds: parseBounds(a.bounds),
      parent, children: [], depth,
    };
    nodes.push(n);
    if (parent) parent.children.push(n); else top.push(n);
    for (const c of el.children) if (c.name === 'node') walk(c, n, depth + 1);
  }
  function find(el) {
    for (const c of el.children) {
      if (c.name === 'node') walk(c, null, 0); else find(c);
    }
  }
  find(doc);
  let width = 0, height = 0;
  for (const t of top) { width = Math.max(width, t.bounds.r); height = Math.max(height, t.bounds.b); }
  return { nodes, top, width, height };
}

const w = (n) => n.bounds.r - n.bounds.l;
const h = (n) => n.bounds.b - n.bounds.t;
const center = (n) => ({ x: Math.round((n.bounds.l + n.bounds.r) / 2), y: Math.round((n.bounds.t + n.bounds.b) / 2) });
const shortId = (rid) => (rid.includes('/') ? rid.split('/').pop() : rid);

function isAncestor(a, b) {
  for (let p = b.parent; p; p = p.parent) if (p === a) return true;
  return false;
}
function inScrollable(n) {
  for (let p = n.parent; p; p = p.parent) if (p.scrollable) return true;
  return false;
}
function isTextInput(n) {
  return /EditText|AutoCompleteTextView|TextInput/.test(n.cls);
}
function descendants(n, out = []) {
  for (const c of n.children) { out.push(c); descendants(c, out); }
  return out;
}
// Every human-visible/identifying string of the node and its subtree.
function labelParts(n) {
  const parts = [];
  for (const x of [n, ...descendants(n)]) {
    if (x.text) parts.push(x.text);
    if (x.desc) parts.push(x.desc);
    if (x.resourceId) parts.push(shortId(x.resourceId));
  }
  return parts;
}
function humanLabel(n) {
  const parts = [];
  for (const x of [n, ...descendants(n)]) { if (x.text) parts.push(x.text); else if (x.desc) parts.push(x.desc); }
  return parts.join(' ').trim();
}
function selectorOf(n) {
  if (n.resourceId) return n.resourceId;
  const b = n.bounds;
  return `${n.cls || 'node'}${n.desc ? `[desc="${n.desc.slice(0, 30)}"]` : ''}@${b.l},${b.t},${b.r},${b.b}`;
}
function foregroundPackage(ui) {
  const counts = {};
  for (const n of ui.nodes) if (n.pkg && n.pkg !== 'com.android.systemui') counts[n.pkg] = (counts[n.pkg] || 0) + 1;
  let best = '', c = 0;
  for (const [k, v] of Object.entries(counts)) if (v > c) { best = k; c = v; }
  return best;
}
// Stable screen signature: activity + set of resource-ids / classes. Text is ignored.
function signature(ui, activity) {
  const tokens = new Set();
  for (const n of ui.nodes) {
    if (n.pkg === 'com.android.systemui') continue;
    tokens.add(n.resourceId ? `id:${n.resourceId}` : `cls:${n.cls}`);
  }
  const s = `${activity || ''}|${[...tokens].sort().join(',')}`;
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}
// Hash used to decide whether the UI has stopped changing (includes text).
function settleHash(ui) {
  const s = ui.nodes.map((n) => `${n.cls}|${n.resourceId}|${n.text}|${n.desc}|${n.bounds.l},${n.bounds.t},${n.bounds.r},${n.bounds.b}`).join('\n');
  return crypto.createHash('sha1').update(s).digest('hex');
}

module.exports = { parseHierarchy, parseBounds, w, h, center, shortId, isAncestor, inScrollable, isTextInput, descendants, labelParts, humanLabel, selectorOf, foregroundPackage, signature, settleHash };
