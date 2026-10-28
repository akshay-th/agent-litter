import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { newFiles } from './git.js';
import { findReferences, scoreFile } from './score.js';
import { readAll } from './sessions.js';

const SLACK_MS = 60_000;

export function rootAliases(root) {
  const out = new Set([root]);
  try {
    out.add(realpathSync.native(root));
  } catch {}
  // macOS: /tmp -> /private/tmp, /var -> /private/var
  for (const r of [...out]) if (r.startsWith('/private/')) out.add(r.slice('/private'.length));
  return [...out];
}

function toRel(roots, p) {
  for (const r of roots) {
    const rel = relative(r, p);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  }
  return null;
}

function createdAt(path) {
  try {
    const st = statSync(path);
    return st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Find files that an agent created and git doesn't track yet, and score them.
 * Returns { root, sessions, agents, candidates: [{ path, status, verdict, score, reasons, evidence }] }
 */
export function analyze(root, { since = 0, home, env, stagedOnly = false, references = true } = {}) {
  const roots = rootAliases(root);
  const { events, windows } = readAll(roots, { since, home, env });

  const byRel = new Map();
  for (const e of events) {
    const rel = toRel(roots, e.path);
    if (!rel) continue;
    if (!byRel.has(rel)) byRel.set(rel, []);
    byRel.get(rel).push(e);
  }

  const candidates = [];
  for (const f of newFiles(root, { stagedOnly })) {
    const evs = byRel.get(f.path) || [];
    const writes = evs.filter((e) => e.kind !== 'ran');
    const ran = evs.filter((e) => e.kind === 'ran');
    const evidence = writes.map((e) => ({ agent: e.agent, session: e.session, time: e.time, kind: e.kind, tool: e.tool }));
    if (!evidence.length) {
      // No direct write seen (e.g. a script the agent ran produced it): fall back
      // to "the file appeared while a session was running".
      const t = createdAt(join(root, f.path));
      const w = t && windows.find((x) => t >= x.start - SLACK_MS && t <= x.end + SLACK_MS);
      if (w) evidence.push({ agent: w.agent, session: w.session, time: t, kind: 'during-session', tool: null });
    }
    if (!evidence.length) continue;
    const referenced = references ? findReferences(root, f.path) : [];
    const ranBy = ran.map((e) => {
      const first = (e.command || e.path).split('\n')[0].trim();
      return first.length > 70 ? `${first.slice(0, 67)}...` : first;
    });
    const s = scoreFile(f.path, { root, evidence, ranBy, referenced });
    candidates.push({ path: f.path, status: f.status, ...s, evidence });
  }
  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    root,
    sessions: windows.length,
    agents: [...new Set(windows.map((w) => w.agent))],
    candidates,
  };
}
