import { isAbsolute, join, normalize } from 'node:path';

// Best-effort reading of shell commands an agent ran: which files did it create,
// and which local scripts did it execute. False negatives are fine (we also use
// session time windows); false positives only add a candidate the user reviews.

const SKIP_TARGET = /^(\/dev\/|&|-$)/;

function unquote(t) {
  return t.replace(/^(['"])(.*)\1$/, '$2');
}

// Split on ; && || | but not inside quotes.
function segments(cmd) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ';' || c === '\n' || (c === '&' && cmd[i + 1] === '&') || c === '|') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      if (cmd[i + 1] === '&' || cmd[i + 1] === '|') i++;
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function words(seg) {
  return (seg.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(unquote);
}

// Drop heredoc bodies: everything after "<<EOF" up to a line that is just EOF.
function stripHeredocs(cmd) {
  return cmd.replace(/<<-?\s*['"]?(\w+)['"]?([^\n]*)\n[\s\S]*?\n\s*\1\s*(\n|$)/g, (_, tag, rest) => `${rest}\n`);
}

const RUNNERS = /^(python[\d.]*|node|bun|deno|tsx|ts-node|ruby|bash|sh|zsh|perl|php|uv|go)$/;

/**
 * @returns {{ creates: string[], runs: string[] }} absolute paths
 */
export function parseCommand(command, cwd) {
  const creates = new Set();
  const runs = new Set();
  let dir = cwd;
  const abs = (p) => normalize(isAbsolute(p) ? p : join(dir, p.replace(/^~(?=\/)/, process.env.HOME || '~')));

  for (const raw of segments(stripHeredocs(String(command || '')))) {
    // redirections: > file, >> file, 2> file, &> file
    for (const m of raw.matchAll(/(?:^|[^<>&\d])(?:\d|&)?>{1,2}\|?\s*("[^"]+"|'[^']+'|[^\s;&|<>()]+)/g)) {
      const t = unquote(m[1]);
      if (!SKIP_TARGET.test(t)) creates.add(abs(t));
    }
    const w = words(raw.replace(/(?:\d|&)?>{1,2}\|?\s*("[^"]+"|'[^']+'|[^\s;&|<>()]+)/g, ''));
    if (!w.length) continue;
    let i = 0;
    while (i < w.length && /^[A-Z_][A-Z0-9_]*=/.test(w[i])) i++; // FOO=bar cmd
    if (w[i] === 'sudo' || w[i] === 'env' || w[i] === 'time') i++;
    const cmd = w[i];
    const args = w.slice(i + 1);
    const files = args.filter((a) => !a.startsWith('-'));
    if (cmd === 'cd' && files[0]) {
      dir = abs(files[0]);
    } else if (cmd === 'touch' || cmd === 'tee') {
      for (const f of files) creates.add(abs(f));
    } else if ((cmd === 'cp' || cmd === 'mv' || cmd === 'ln') && files.length >= 2) {
      const dest = files[files.length - 1];
      if (!dest.endsWith('/') && dest !== '.') creates.add(abs(dest));
    } else if (cmd === 'curl' || cmd === 'wget') {
      const o = args.findIndex((a) => a === '-o' || a === '--output' || a === '-O');
      if (o !== -1 && args[o + 1] && args[o] !== '-O') creates.add(abs(args[o + 1]));
    } else if (cmd && RUNNERS.test(cmd)) {
      // python foo.py / node scripts/check.js / uv run x.py / go run main.go
      const script = files.find((f) => /\.(py|js|mjs|cjs|ts|mts|rb|sh|pl|php|go)$/.test(f));
      if (script) runs.add(abs(script));
    } else if (cmd && /^\.{0,2}\//.test(cmd) && /\.(sh|py|js|rb)$/.test(cmd)) {
      runs.add(abs(cmd));
    }
  }
  return { creates: [...creates], runs: [...runs] };
}
