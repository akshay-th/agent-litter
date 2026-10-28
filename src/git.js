import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function repoRoot(cwd) {
  try {
    return git(['rev-parse', '--show-toplevel'], cwd).trim();
  } catch {
    return null;
  }
}

export function gitDir(root) {
  return git(['rev-parse', '--absolute-git-dir'], root).trim();
}

/**
 * New files git doesn't track yet: untracked (??) and staged-but-new (A).
 * Returns [{ path (repo-relative, posix), status: 'untracked' | 'staged' }]
 */
export function newFiles(root, { stagedOnly = false } = {}) {
  const out = git(['status', '--porcelain=v1', '-z', stagedOnly ? '--untracked-files=no' : '--untracked-files=all'], root);
  const res = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const x = e[0];
    const y = e[1];
    const path = e.slice(3);
    if (x === 'R' || x === 'C') i++; // rename/copy: next entry is the source
    if (x === '?' && y === '?') res.push({ path, status: 'untracked' });
    else if (x === 'A') res.push({ path, status: 'staged' });
  }
  return res;
}

/** Tracked files (working-tree contents, other than `self`) that mention any needle. */
export function referencedBy(root, needles, self) {
  needles = needles.filter((n) => n && n.length >= 3);
  if (!needles.length) return [];
  const r = spawnSync('git', ['grep', '-l', '-F', ...needles.flatMap((n) => ['-e', n])], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .filter((f) => f !== self);
}

export function addToExclude(root, paths) {
  const file = join(gitDir(root), 'info', 'exclude');
  const existing = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  const add = paths.map((p) => `/${p}`).filter((p) => !existing.includes(p));
  if (add.length) appendFileSync(file, `${existing.length && existing[existing.length - 1] !== '' ? '\n' : ''}# agent-litter\n${add.join('\n')}\n`);
  return add;
}
