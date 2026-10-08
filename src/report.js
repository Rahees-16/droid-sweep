'use strict';
const fs = require('fs');
const path = require('path');

const SEVS = ['high', 'medium', 'low'];

function buildGraph(result) {
  const nodes = result.screens.map((s) => ({ id: s.id, activity: s.activity, depth: s.depth }));
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of result.edges) if (!ids.has(e.to)) { ids.add(e.to); nodes.push({ id: e.to, external: true }); }
  return { root: result.root, nodes, edges: result.edges.map((e) => ({ from: e.from, to: e.to, via: e.via, kind: e.kind })) };
}

function mermaid(graph) {
  const m = (id) => 'n_' + id.replace(/[^A-Za-z0-9]/g, '_');
  const q = (s) => String(s).replace(/["\n\r]/g, ' ').slice(0, 40);
  const lines = ['```mermaid', 'flowchart TD'];
  for (const n of graph.nodes) lines.push(`  ${m(n.id)}["${q(n.id)}"]${n.external ? ':::external' : ''}`);
  for (const e of graph.edges) lines.push(`  ${m(e.from)} -->|"${q(e.via || 'tap')}"| ${m(e.to)}`);
  lines.push('  classDef external stroke-dasharray: 4 2', '```');
  return `# Screen graph\n\n${lines.join('\n')}\n`;
}

function countBySeverity(findings) {
  const c = { high: 0, medium: 0, low: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

function buildReport(result, params, meta = {}) {
  const findings = [...result.findings].sort((a, b) => SEVS.indexOf(a.severity) - SEVS.indexOf(b.severity) || a.type.localeCompare(b.type) || a.fingerprint.localeCompare(b.fingerprint));
  return {
    tool: 'droid-sweep', version: meta.version || '0.1.0', package: params.pkg,
    startedAt: meta.startedAt, finishedAt: meta.finishedAt,
    params: { maxScreens: params.maxScreens, maxActions: params.maxActions, maxDepth: params.maxDepth, settleMs: params.settleMs, slowMs: params.slowMs, denylist: params.policy.keywords },
    summary: { screens: result.screens.length, actions: result.stats.actions, findings: findings.length, bySeverity: countBySeverity(findings), skippedDenylisted: result.skipped.filter((s) => s.reason === 'denylisted').length, externalExits: result.externalExits.length },
    screens: result.screens.map((s) => ({ id: s.id, activity: s.activity, depth: s.depth, actionable: s.elements.length, tried: s.tried.size })),
    findings,
    skipped: result.skipped,
    externalExits: result.externalExits,
  };
}

function renderMarkdown(rep) {
  const L = [];
  L.push(`# droid-sweep report: ${rep.package}`, '');
  const s = rep.summary;
  L.push(`Screens: **${s.screens}** | Actions: **${s.actions}** | Findings: **${s.findings}** (high ${s.bySeverity.high}, medium ${s.bySeverity.medium}, low ${s.bySeverity.low}) | Skipped (denylisted): **${s.skippedDenylisted}**`, '');
  for (const sev of SEVS) {
    const fs_ = rep.findings.filter((f) => f.severity === sev);
    if (!fs_.length) continue;
    L.push(`## ${sev} (${fs_.length})`, '');
    for (const f of fs_) {
      L.push(`- **${f.type}** on \`${f.screen}\` - \`${f.selector}\`: ${f.message.split('\n')[0]} (\`${f.fingerprint}\`)${f.screenshot ? ` [screenshot](${f.screenshot})` : ''}`);
      if (f.type === 'crash') L.push('  ```', ...f.message.split('\n').slice(0, 15).map((l) => '  ' + l), '  ```');
    }
    L.push('');
  }
  if (!rep.findings.length) L.push('No findings.', '');
  L.push('## Screens', '', '| id | activity | depth | actionable | tried |', '|---|---|---|---|---|');
  for (const sc of rep.screens) L.push(`| ${sc.id} | ${sc.activity || ''} | ${sc.depth} | ${sc.actionable} | ${sc.tried} |`);
  L.push('', '## Skipped (denylisted)', '');
  const sk = rep.skipped.filter((x) => x.reason === 'denylisted');
  if (!sk.length) L.push('None.');
  for (const x of sk) L.push(`- \`${x.screen}\` \`${x.selector}\` "${x.label}" (keyword: ${x.keyword})`);
  const other = rep.skipped.filter((x) => x.reason !== 'denylisted');
  if (other.length) {
    L.push('', '## Skipped (never interacted with)', '');
    for (const x of other) L.push(`- \`${x.screen}\` \`${x.selector}\` (${x.reason})`);
  }
  L.push('', '## External exits', '');
  if (!rep.externalExits.length) L.push('None.');
  for (const x of rep.externalExits) L.push(`- \`${x.from}\` via \`${x.via}\` left the app into \`${x.pkg}\``);
  L.push('', '## Limitations', '', '- No text input; no contrast check; WebViews are opaque.', '');
  return L.join('\n');
}

function writeOutputs(outDir, rep, graph) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(rep, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'report.md'), renderMarkdown(rep));
  fs.writeFileSync(path.join(outDir, 'graph.json'), JSON.stringify(graph, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'graph.md'), mermaid(graph));
}

module.exports = { buildReport, buildGraph, mermaid, renderMarkdown, writeOutputs, countBySeverity };
