import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeDirName, geminiProjectHash } from '../src/sessions.js';

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86400e3;

export function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
}

/** A repo with one commit, plus a HOME holding transcripts for it. */
export function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'litter-')));
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'index.ts'), "import { feature } from './feature';\nfeature();\n");
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  return { base, home, repo };
}

export function writeClaude(home, cwd, session, entries) {
  const dir = join(home, '.claude', 'projects', claudeDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const lines = entries.map(([msAgo, content, extra = {}]) =>
    JSON.stringify({ type: 'assistant', cwd, sessionId: session, timestamp: iso(msAgo), message: { role: 'assistant', content }, ...extra }),
  );
  lines.unshift(JSON.stringify({ type: 'user', cwd, sessionId: session, timestamp: iso(entries[0][0] + 1000), message: { role: 'user', content: 'hi' } }));
  writeFileSync(join(dir, `${session}.jsonl`), `${lines.join('\n')}\n`);
}

export const tool = (name, input) => [{ type: 'tool_use', id: `t${Math.random()}`, name, input }];

export function writeCodex(home, cwd, entries) {
  const dir = join(home, '.codex', 'sessions', '2026', '10', '28');
  mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ timestamp: iso(2 * DAY), type: 'session_meta', payload: { id: 'codex-session-1', cwd } })];
  for (const [msAgo, payload] of entries) lines.push(JSON.stringify({ timestamp: iso(msAgo), type: 'response_item', payload }));
  writeFileSync(join(dir, 'rollout-2026-10-28T10-00-00-codex-session-1.jsonl'), `${lines.join('\n')}\n`);
}

export function writeGemini(home, root, messages) {
  const dir = join(home, '.gemini', 'tmp', geminiProjectHash(root), 'chats');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session-1.json'), JSON.stringify({ sessionId: 'gemini-1', messages }));
}

export { DAY, iso };
