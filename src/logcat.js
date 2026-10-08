'use strict';
const LINE = /^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.+?)\s*:\s?(.*)$/;

function parseLine(line) {
  const m = LINE.exec(line);
  return m ? { pid: +m[1], level: m[3], tag: m[4].trim(), msg: m[5] } : null;
}

// Analyse a `logcat -d -v threadtime` dump for a given package / pid.
function analyseLogcat(text, { pkg, pid } = {}) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''));
  const out = { crashes: [], anrs: [], skippedFrames: 0, strictMode: [], errors: [] };
  const seenErr = new Set();
  for (let i = 0; i < lines.length; i++) {
    const p = parseLine(lines[i]);
    if (!p) continue;
    if (p.tag === 'AndroidRuntime' && p.msg.startsWith('FATAL EXCEPTION')) {
      const trace = [];
      let proc = null;
      for (let j = i + 1; j < lines.length && trace.length < 40; j++) {
        const q = parseLine(lines[j]);
        if (!q || q.tag !== 'AndroidRuntime') break;
        const pm = /^Process:\s*([^,\s]+)/.exec(q.msg);
        if (pm) { proc = pm[1]; continue; }
        trace.push(q.msg);
      }
      if (proc === pkg || (!proc && pid && p.pid === pid)) {
        out.crashes.push({ exception: trace[0] || 'FATAL EXCEPTION', trace: trace.join('\n') });
      }
      continue;
    }
    if (p.tag === 'AndroidRuntime') continue;
    const am = /^ANR in ([^\s(]+)/.exec(p.msg);
    if (am && am[1] === pkg) { out.anrs.push({ message: p.msg }); continue; }
    const mine = pid ? p.pid === pid : p.msg.includes(pkg || '\0');
    if (!mine) continue;
    const sf = /Skipped (\d+) frames/.exec(p.msg);
    if (p.tag === 'Choreographer' && sf) { out.skippedFrames = Math.max(out.skippedFrames, +sf[1]); continue; }
    if (p.tag === 'StrictMode') { if (out.strictMode.length < 5) out.strictMode.push(p.msg.slice(0, 200)); continue; }
    if (p.level === 'E' || p.level === 'F') {
      const k = `${p.tag}:${p.msg.slice(0, 120)}`;
      if (!seenErr.has(k) && out.errors.length < 5) { seenErr.add(k); out.errors.push({ tag: p.tag, msg: p.msg.slice(0, 200) }); }
    }
  }
  return out;
}

module.exports = { analyseLogcat, parseLine };
