import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { parseCommand } from './bash.js';

// Everything an agent session tells us about files in the repo.
//   event: { agent, session, time, kind: 'write' | 'edit' | 'shell-create' | 'ran', path, tool }
//   window: { agent, session, start, end }

const inside = (root, p) => {
  const r = relative(root, p);
  return r && !r.startsWith('..') && !isAbsolute(r);
};

// `roots` are equivalent spellings of the repo root (e.g. /tmp/x and /private/tmp/x)
const within = (roots, p) => roots.some((r) => p === r || inside(r, p));
// A session started in a parent directory can still write into the repo.
const above = (roots, p) => roots.some((r) => inside(p, r));

function ancestors(p) {
  const out = [];
  for (let d = dirname(p); d !== dirname(d); d = dirname(d)) out.push(d);
  return out;
}

function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function listFiles(dir, re, depth = 0, out = []) {
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of names) {
    const p = join(dir, d.name);
    if (d.isDirectory() && depth < 6) listFiles(p, re, depth + 1, out);
    else if (d.isFile() && re.test(d.name)) out.push(p);
  }
  return out;
}

const recent = (file, since) => {
  try {
    return statSync(file).mtimeMs >= since;
  } catch {
    return false;
  }
};

/** Claude Code encodes the project cwd as the directory name: /a/b.c -> -a-b-c */
export function claudeDirName(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

const CLAUDE_FILE_TOOLS = { Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit' };

export function readClaude(roots, { home = homedir(), env = process.env, since = 0 } = {}) {
  const root = roots[0];
  const base = join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects');
  const events = [];
  const windows = [];
  if (!existsSync(base)) return { events, windows };
  const prefixes = roots.map(claudeDirName);
  const parents = new Set(roots.flatMap(ancestors).map(claudeDirName));
  // Sessions started in the repo or any subdirectory share the encoded prefix;
  // sessions started in a parent directory have exactly that parent's name.
  const dirs = readdirSync(base).filter((d) => parents.has(d) || prefixes.some((p) => d === p || d.startsWith(`${p}-`)));
  for (const d of dirs) {
    for (const file of listFiles(join(base, d), /\.jsonl$/)) {
      if (!recent(file, since)) continue;
      const session = file.split(sep).pop().replace(/\.jsonl$/, '');
      let start = Infinity;
      let end = 0;
      let inRepo = false;
      let touched = false;
      const before = events.length;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        const hasTool = line.includes('"tool_use"');
        if (!hasTool && !line.includes('"timestamp"')) continue;
        const e = safeJson(line);
        if (!e) continue;
        const time = Date.parse(e.timestamp) || 0;
        const cwd = e.cwd || root;
        const here = within(roots, cwd);
        if (!here && !above(roots, cwd)) continue;
        if (here) inRepo = true;
        if (time) {
          start = Math.min(start, time);
          end = Math.max(end, time);
        }
        if (!hasTool || e.type !== 'assistant') continue;
        for (const c of e.message?.content || []) {
          if (c?.type !== 'tool_use' || !c.input) continue;
          const kind = CLAUDE_FILE_TOOLS[c.name];
          const fp = c.input.file_path || c.input.notebook_path;
          if (kind && typeof fp === 'string') {
            events.push({ agent: 'Claude Code', session, time, kind, path: normalize(isAbsolute(fp) ? fp : join(cwd, fp)), tool: c.name });
          } else if (c.name === 'Bash' && typeof c.input.command === 'string') {
            pushShell(events, 'Claude Code', session, time, c.input.command, cwd);
          }
        }
      }
      touched = events.slice(before).some((e) => within(roots, e.path));
      if ((inRepo || touched) && end) windows.push({ agent: 'Claude Code', session, start, end });
    }
  }
  return { events, windows };
}

function pushShell(events, agent, session, time, command, cwd) {
  const { creates, runs } = parseCommand(command, cwd);
  for (const p of creates) events.push({ agent, session, time, kind: 'shell-create', path: p, tool: 'shell' });
  for (const p of runs) events.push({ agent, session, time, kind: 'ran', path: p, tool: 'shell', command: command.slice(0, 200) });
}

function patchAdds(text, cwd) {
  const out = [];
  for (const m of String(text).matchAll(/^\*\*\* (Add|Update) File: (.+)$/gm)) {
    const p = m[2].trim();
    out.push({ kind: m[1] === 'Add' ? 'write' : 'edit', path: normalize(isAbsolute(p) ? p : join(cwd, p)) });
  }
  return out;
}

export function readCodex(roots, { home = homedir(), env = process.env, since = 0 } = {}) {
  const base = join(env.CODEX_HOME || join(home, '.codex'), 'sessions');
  const events = [];
  const windows = [];
  if (!existsSync(base)) return { events, windows };
  for (const file of listFiles(base, /^rollout-.*\.jsonl$/)) {
    if (!recent(file, since)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    const meta = safeJson(lines[0] || '');
    const cwd = meta?.payload?.cwd || meta?.cwd;
    if (!cwd || !(within(roots, cwd) || above(roots, cwd))) continue;
    const before = events.length;
    const session = meta?.payload?.id || file.split(sep).pop().replace(/\.jsonl$/, '');
    let start = Infinity;
    let end = 0;
    for (const line of lines) {
      const e = safeJson(line);
      if (!e) continue;
      const time = Date.parse(e.timestamp) || 0;
      if (time) {
        start = Math.min(start, time);
        end = Math.max(end, time);
      }
      const p = e.payload || e;
      if (p.type !== 'function_call' && p.type !== 'custom_tool_call' && p.type !== 'local_shell_call') continue;
      let args = p.arguments ?? p.input ?? p.action;
      if (typeof args === 'string') args = safeJson(args) ?? args;
      const workdir = (args && typeof args === 'object' && (args.workdir || args.cwd)) || cwd;
      if (typeof args === 'string' && args.includes('*** Begin Patch')) {
        for (const a of patchAdds(args, workdir)) events.push({ agent: 'Codex', session, time, ...a, tool: 'apply_patch' });
        continue;
      }
      if (args && typeof args === 'object') {
        if (typeof args.input === 'string' && args.input.includes('*** Begin Patch')) {
          for (const a of patchAdds(args.input, workdir)) events.push({ agent: 'Codex', session, time, ...a, tool: 'apply_patch' });
          continue;
        }
        const cmd = Array.isArray(args.command) ? args.command : typeof args.cmd === 'string' ? ['sh', '-c', args.cmd] : typeof args.command === 'string' ? ['sh', '-c', args.command] : null;
        if (cmd) {
          const script = cmd.length >= 3 && /^-?l?c$/.test(cmd[cmd.length - 2]) ? cmd[cmd.length - 1] : cmd.join(' ');
          if (script.includes('*** Begin Patch')) {
            for (const a of patchAdds(script, workdir)) events.push({ agent: 'Codex', session, time, ...a, tool: 'apply_patch' });
          } else pushShell(events, 'Codex', session, time, script, workdir);
        }
      }
    }
    const touched = events.slice(before).some((e) => within(roots, e.path));
    if (end && (within(roots, cwd) || touched)) windows.push({ agent: 'Codex', session, start, end });
  }
  return { events, windows };
}

/** Gemini CLI keeps chats under ~/.gemini/tmp/<sha256(projectRoot)>/ */
export function geminiProjectHash(root) {
  return createHash('sha256').update(root).digest('hex');
}

const GEMINI_WRITE_TOOLS = { write_file: 'write', replace: 'edit', edit: 'edit' };

export function readGemini(roots, { home = homedir(), since = 0 } = {}) {
  const events = [];
  const windows = [];
  const files = roots.flatMap((r) => listFiles(join(home, '.gemini', 'tmp', geminiProjectHash(r)), /\.json$/));
  for (const file of new Set(files)) {
    if (!recent(file, since)) continue;
    const data = safeJson(readFileSync(file, 'utf8'));
    if (!data) continue;
    const session = data.sessionId || file.split(sep).pop().replace(/\.json$/, '');
    const root = roots[0];
    let start = Infinity;
    let end = 0;
    const visit = (node, time) => {
      if (Array.isArray(node)) return node.forEach((n) => visit(n, time));
      if (!node || typeof node !== 'object') return;
      const t = Date.parse(node.timestamp) || time;
      if (t) {
        start = Math.min(start, t);
        end = Math.max(end, t);
      }
      const args = node.args || node.arguments;
      if (typeof node.name === 'string' && args && typeof args === 'object') {
        const kind = GEMINI_WRITE_TOOLS[node.name];
        const fp = args.file_path || args.absolute_path || args.path;
        if (kind && typeof fp === 'string') {
          events.push({ agent: 'Gemini CLI', session, time: t, kind, path: normalize(isAbsolute(fp) ? fp : join(root, fp)), tool: node.name });
        } else if (node.name === 'run_shell_command' && typeof args.command === 'string') {
          pushShell(events, 'Gemini CLI', session, t, args.command, args.directory ? join(root, args.directory) : root);
        }
      }
      for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v, t);
    };
    visit(data, 0);
    if (end) windows.push({ agent: 'Gemini CLI', session, start, end });
  }
  return { events, windows };
}

export function readAll(roots, opts = {}) {
  const parts = [readClaude(roots, opts), readCodex(roots, opts), readGemini(roots, opts)];
  return { events: parts.flatMap((p) => p.events), windows: parts.flatMap((p) => p.windows) };
}
