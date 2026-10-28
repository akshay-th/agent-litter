import { statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { referencedBy } from './git.js';

// Names agents give throwaway files. Strong words mean scratch anywhere; weak
// ones ("check", "verify", "output") are normal module names inside src/.
const STRONG_NAME = /^(tmp|temp|scratch|debug|repro|reproduce|playground|sandbox|throwaway|adhoc|ad_hoc|demo_test|simple_test|test_(output|run|script|fix|debug|quick|simple|manual|temp|tmp|check|verify|my|new))([-_.\d]|$)/i;
const WEAK_NAME = /^(try|trial|quick|check|verify|validate|inspect|investigate|analyze|explore|probe|manual|fix_|patch_|run_|out|output|result|results|dump)([-_.\d]|$)/i;
const SOURCE_DIR = /(^|\/)(src|lib|bin|app|apps|packages|components|pkg|internal|cmd|server|client|scripts|tools|crates)\//;
const BACKUP_EXT = /(\.(bak|orig|old|backup|tmp|temp|swp|log|rej)|~|[-_.](old|backup|copy|orig))$/i;
// Status/summary documents written for the chat, not the project.
const REPORT_MD = /^[A-Z0-9_-]*(SUMMARY|REPORT|NOTES|PLAN|CHANGES|CHANGELOG_DRAFT|IMPLEMENTATION|ANALYSIS|FIXES?|PROGRESS|STATUS|REVIEW|FINDINGS|INVESTIGATION|DEBUG|TESTING|VERIFICATION|COMPLETE|COMPLETED|DONE|WALKTHROUGH|EXPLANATION)[A-Z0-9_-]*\.(md|txt)$/;
const SCRATCH_DIR = /(^|\/)(tmp|temp|scratch|debug|playground|sandbox|\.scratch|\.tmp)\//i;
const DATA_DUMP = /\.(log|out|dump|csv|tsv|jsonl|prof|heapsnapshot|trace)$/i;

const TEST_DIRS = /(^|\/)(tests?|__tests__|spec|specs)\//;

/**
 * Score one agent-created, not-yet-committed file.
 * Positive = looks like litter. Returns { score, verdict, reasons: [{ points, text }] }.
 */
export function scoreFile(rel, ctx) {
  const { root, evidence = [], ranBy = [], referenced = null } = ctx;
  const name = basename(rel);
  const dir = dirname(rel);
  const reasons = [];
  const add = (points, text) => reasons.push({ points, text });

  if (REPORT_MD.test(name)) add(3, 'status/summary document written for the chat');
  const inSource = SOURCE_DIR.test(rel);
  if (STRONG_NAME.test(name)) add(2, 'scratch-style file name');
  else if (WEAK_NAME.test(name) && !inSource) add(2, 'scratch-style file name');
  if (BACKUP_EXT.test(name)) add(3, 'backup / temp file extension');
  if (SCRATCH_DIR.test(`${rel}`)) add(2, 'inside a scratch directory');
  if (DATA_DUMP.test(name) && !TEST_DIRS.test(rel)) add(1, 'output / dump file type');
  if (ranBy.length && !inSource) add(2, `agent ran it as a one-off: ${ranBy[0]}`);
  if (dir === '.' && /\.(py|js|mjs|cjs|ts|sh|rb)$/.test(name) && !/^(index|main|app|server|setup|config|manage|vite|next|jest|vitest|eslint|tailwind|postcss|webpack|rollup|babel|prettier)\b/.test(name)) {
    add(1, 'loose script in the repo root');
  }
  if (/^test[_-].*\.(py|js|ts)$|[_.-]test\.(py|js|ts)$/.test(name) && !TEST_DIRS.test(rel) && dir === '.') add(1, 'test file outside the test directories');

  if (referenced && referenced.length) add(-3, `referenced by ${referenced.slice(0, 2).join(', ')}${referenced.length > 2 ? ` +${referenced.length - 2}` : ''}`);
  if (TEST_DIRS.test(rel) && !STRONG_NAME.test(name)) add(-2, 'lives with the project tests');
  if (evidence.some((e) => e.kind === 'edit')) add(-1, 'agent kept editing it');

  try {
    const st = statSync(join(root, rel));
    if (st.size === 0) add(1, 'empty file');
  } catch {}

  const score = reasons.reduce((n, r) => n + r.points, 0);
  const verdict = score >= 2 ? 'litter' : score >= 1 ? 'maybe' : 'keep';
  return { score, verdict, reasons };
}

/** Strings that would show up in a file that uses this one. */
export function needlesFor(rel) {
  const name = basename(rel);
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const needles = [name];
  if (/^\.(m?[jt]sx?|cjs|vue|svelte)$/.test(ext)) needles.push(`/${stem}'`, `/${stem}"`, `/${stem}.`);
  if (ext === '.py') needles.push(`import ${stem}`, `from ${stem} `, `.${stem} import`);
  return needles;
}

export function findReferences(root, rel) {
  return referencedBy(root, needlesFor(rel), rel);
}
