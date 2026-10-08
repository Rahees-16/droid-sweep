'use strict';
const { execFile } = require('child_process');

// The ONLY module that talks to the `gh` CLI. A runner is (args, {input}) -> Promise<{code, stdout, stderr}>.
function defaultRunner(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile('gh', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

function createGh(runner = defaultRunner) {
  async function run(args, opts) {
    const r = await runner(args, opts);
    if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return r.stdout;
  }
  return {
    async listOpenIssues(repo) {
      const out = await run(['issue', 'list', '-R', repo, '--state', 'open', '--limit', '500', '--json', 'number,title,body']);
      return JSON.parse(out || '[]');
    },
    async listLabels(repo) {
      const out = await run(['label', 'list', '-R', repo, '--limit', '500', '--json', 'name']);
      return JSON.parse(out || '[]').map((l) => l.name);
    },
    async createLabel(repo, { name, color, description }) {
      await run(['label', 'create', name, '-R', repo, '--color', color, '--description', description]);
    },
    async createIssue(repo, { title, body, labels }) {
      const out = await run(['issue', 'create', '-R', repo, '--title', title, '--body-file', '-', ...labels.flatMap((l) => ['--label', l])], { input: body });
      return out.trim();
    },
  };
}

module.exports = { createGh, defaultRunner };
