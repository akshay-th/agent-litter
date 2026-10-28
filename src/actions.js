import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitDir } from './git.js';

export function trashDir(root) {
  return join(gitDir(root), 'agent-litter');
}

function move(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyFileSync(from, to);
    rmSync(from);
  }
}

/**
 * Move files into .git/agent-litter/<batch>/ (git never tracks it, and
 * `restore` can put them back). With del: true they are deleted instead.
 */
export function clean(root, rels, { del = false, now = new Date() } = {}) {
  if (del) {
    for (const r of rels) rmSync(join(root, r), { force: true });
    return { batch: null, files: rels };
  }
  const batch = now.toISOString().replace(/[:.]/g, '-');
  const dir = join(trashDir(root), batch);
  for (const r of rels) move(join(root, r), join(dir, 'files', r));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ created: now.toISOString(), files: rels }, null, 2));
  return { batch, files: rels, dir };
}

export function batches(root) {
  const dir = trashDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((b) => existsSync(join(dir, b, 'manifest.json')))
    .sort()
    .map((b) => ({ batch: b, ...JSON.parse(readFileSync(join(dir, b, 'manifest.json'), 'utf8')) }));
}

export function restore(root, batch) {
  const all = batches(root);
  const b = batch ? all.find((x) => x.batch === batch) : all[all.length - 1];
  if (!b) throw new Error(batch ? `no batch "${batch}"` : 'nothing to restore');
  const dir = join(trashDir(root), b.batch);
  const restored = [];
  const conflicts = [];
  for (const r of b.files) {
    const src = join(dir, 'files', r);
    const dest = join(root, r);
    if (!existsSync(src)) continue;
    if (existsSync(dest)) {
      conflicts.push(r);
      continue;
    }
    move(src, dest);
    restored.push(r);
  }
  if (!conflicts.length) rmSync(dir, { recursive: true, force: true });
  return { batch: b.batch, restored, conflicts };
}

const HOOK_MARK = '# agent-litter pre-commit hook';

export function installHook(root, command) {
  const hooks = join(gitDir(root), 'hooks');
  const file = join(hooks, 'pre-commit');
  const body = `${HOOK_MARK}\n${command} check --staged || exit 1\n`;
  mkdirSync(hooks, { recursive: true });
  if (existsSync(file)) {
    const cur = readFileSync(file, 'utf8');
    if (cur.includes(HOOK_MARK)) return { file, status: 'already-installed' };
    writeFileSync(file, `${cur.replace(/\n?$/, '\n')}\n${body}`);
    return { file, status: 'appended' };
  }
  writeFileSync(file, `#!/bin/sh\n${body}`);
  chmodSync(file, 0o755);
  return { file, status: 'created' };
}
