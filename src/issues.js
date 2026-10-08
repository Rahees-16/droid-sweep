'use strict';
const crypto = require('crypto');

const SEV_ORDER = { high: 3, medium: 2, low: 1 };
const SEV_COLOR = { high: 'b60205', medium: 'fbca04', low: '0e8a16' };

function groupFindings(findings, pkg) {
  const map = new Map();
  for (const f of findings) {
    const k = `${f.type}|${f.severity}`;
    if (!map.has(k)) map.set(k, { type: f.type, severity: f.severity, findings: [] });
    map.get(k).findings.push(f);
  }
  const groups = [...map.values()];
  for (const g of groups) g.key = crypto.createHash('sha1').update(`droid-sweep|${pkg}|${g.type}|${g.severity}`).digest('hex').slice(0, 16);
  return groups.sort((a, b) => SEV_ORDER[b.severity] - SEV_ORDER[a.severity] || a.type.localeCompare(b.type));
}

const marker = (key) => `<!-- droid-sweep:fingerprint=${key} -->`;

function buildIssue(group, pkg) {
  const screens = [...new Set(group.findings.map((f) => f.screen))];
  const rows = group.findings.slice(0, 50).map((f) => `- \`${f.screen}\` - \`${f.selector}\`: ${f.message.split('\n')[0]}`);
  const more = group.findings.length > 50 ? `\n- ... and ${group.findings.length - 50} more` : '';
  const body = [
    `droid-sweep found **${group.findings.length}** \`${group.type}\` finding(s) with severity **${group.severity}** in \`${pkg}\`.`,
    '',
    `Affected screens (${screens.length}): ${screens.map((s) => `\`${s}\``).join(', ')}`,
    '',
    '### Findings',
    ...rows,
    more,
    '',
    group.type === 'crash' ? '### First stack trace\n```\n' + group.findings[0].message.slice(0, 3000) + '\n```\n' : '',
    marker(group.key),
    '',
    '_Filed by droid-sweep. Verify against a test build before acting._',
  ].filter((l) => l !== undefined).join('\n');
  return { title: `[droid-sweep] ${group.type} (${group.severity}) in ${pkg}`, labels: ['droid-sweep', `severity:${group.severity}`], body, key: group.key };
}

async function fileIssues({ repo, findings, pkg, gh, yes = false, maxIssues = 20, out = console.log }) {
  const groups = groupFindings(findings, pkg);
  const considered = groups.slice(0, maxIssues);
  const result = { dryRun: !yes, planned: considered.length, created: [], duplicates: [], capped: groups.length - considered.length };
  const issues = considered.map((g) => buildIssue(g, pkg));
  if (!yes) {
    out(`[droid-sweep] DRY RUN: no issues will be created in ${repo}. Pass --yes together with --create-issues to file them.`);
    for (const i of issues) {
      out(`\n--- would create issue ---\nTitle: ${i.title}\nLabels: ${i.labels.join(', ')}\n\n${i.body}\n`);
    }
    if (result.capped) out(`(${result.capped} more group(s) not shown: --max-issues ${maxIssues})`);
    return result;
  }
  if (!issues.length) return result;
  const open = await gh.listOpenIssues(repo);
  const existing = new Set(await gh.listLabels(repo));
  for (const i of issues) {
    const dup = open.find((x) => (x.body || '').includes(marker(i.key)));
    if (dup) { result.duplicates.push({ number: dup.number, title: i.title }); out(`skip duplicate of #${dup.number}: ${i.title}`); continue; }
    for (const l of i.labels) {
      if (existing.has(l)) continue;
      const sev = l.startsWith('severity:') ? l.slice(9) : null;
      await gh.createLabel(repo, { name: l, color: sev ? SEV_COLOR[sev] : '1d76db', description: sev ? `droid-sweep ${sev} severity` : 'Filed by droid-sweep' });
      existing.add(l);
    }
    const url = await gh.createIssue(repo, { title: i.title, body: i.body, labels: i.labels });
    result.created.push(url);
    out(`created: ${url}`);
  }
  if (result.capped) out(`(${result.capped} more group(s) skipped: --max-issues ${maxIssues})`);
  return result;
}

module.exports = { groupFindings, buildIssue, fileIssues, marker };
