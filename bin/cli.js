#!/usr/bin/env node
import { homedir } from 'node:os';
import { sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { batches, clean, installHook, restore } from '../src/actions.js';
import { analyze } from '../src/analyze.js';
import { addToExclude, repoRoot } from '../src/git.js';

const HELP = `agent-litter — find the scratch files your AI coding agent left in the repo

Reads Claude Code, Codex and Gemini CLI session transcripts for this repo, finds
files the agent created that git doesn't track yet, and flags the throwaway ones
(debug scripts, *_SUMMARY.md reports, .bak copies, one-off test runners...).

Usage
  agent-litter [list]       show agent-created untracked/new files and a verdict
  agent-litter clean        move litter to .git/agent-litter/ (recoverable)
  agent-litter restore      put the last cleaned batch back (or: restore <batch>)
  agent-litter ignore       add litter to .git/info/exclude instead of moving it
  agent-litter check        exit 1 if litter is present (use --staged in a pre-commit hook)
  agent-litter install-hook add "check --staged" to .git/hooks/pre-commit

Options
  -a, --all             list: also show files that look intentional
  -m, --include-maybe   clean/ignore/check: also act on "maybe" files
      --staged          check: only look at staged new files
      --since <dur>     only sessions active in the last 7d / 12h (default 30d)
      --delete          clean: delete instead of moving to .git/agent-litter
  -y, --yes             clean: don't ask
  -n, --dry-run         clean/ignore: show what would happen
      --json
  -h, --help
`;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c) => (s) => (color ? `\x1b[${c}m${s}\x1b[0m` : String(s));
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);
const TAG = { litter: red('litter'), maybe: yellow('maybe '), keep: green('keep  ') };

function parseSince(s) {
  const m = /^(\d+)\s*(h|d|w)$/.exec(String(s).trim());
  if (!m) throw new Error(`bad --since "${s}" (try 12h, 7d, 2w)`);
  return Date.now() - Number(m[1]) * { h: 3600e3, d: 86400e3, w: 604800e3 }[m[2]];
}

const ago = (t) => {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  return s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

const tildify = (p) => {
  const home = homedir();
  return p === home || p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p;
};

function describeEvidence(ev) {
  const e = ev[0];
  const how = { write: `created with ${e.tool}`, edit: `edited with ${e.tool}`, 'shell-create': 'created by a shell command', 'during-session': 'appeared during a session' }[e.kind];
  return `${e.agent}, ${how}, ${ago(e.time)} · session ${String(e.session).slice(0, 8)}`;
}

function printList(res, { all }) {
  const shown = all ? res.candidates : res.candidates.filter((c) => c.verdict !== 'keep');
  console.log(dim(`${tildify(res.root)} · ${res.sessions} session(s) from ${res.agents.join(', ') || 'no agents'}`));
  if (!res.sessions) {
    console.log('No agent sessions found for this repo.');
    return;
  }
  if (!shown.length) {
    const kept = res.candidates.length;
    console.log(`${green('✓')} no litter${kept ? dim(` (${kept} agent-created file(s) look intentional; --all to list)`) : ''}`);
    return;
  }
  for (const c of shown) {
    console.log(`${TAG[c.verdict]} ${bold(c.path)}${c.status === 'staged' ? yellow(' [staged]') : ''}`);
    console.log(dim(`       ${describeEvidence(c.evidence)}`));
    for (const r of c.reasons) console.log(dim(`       ${r.points > 0 ? '+' : ''}${r.points} ${r.text}`));
  }
  const litter = res.candidates.filter((c) => c.verdict === 'litter').length;
  const maybe = res.candidates.filter((c) => c.verdict === 'maybe').length;
  console.log(`\n${litter} litter, ${maybe} maybe. ${bold('agent-litter clean')} moves litter to .git/agent-litter/ (undo: agent-litter restore).`);
}

async function confirm(q) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

function hookCommand() {
  const self = fileURLToPath(import.meta.url);
  if (/[\\/]_npx[\\/]/.test(self)) return 'npx -y github:akshay-th/agent-litter';
  return `"${process.execPath}" "${self}"`;
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: 'boolean', short: 'a' },
      'include-maybe': { type: 'boolean', short: 'm' },
      staged: { type: 'boolean' },
      since: { type: 'string' },
      delete: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'dry-run': { type: 'boolean', short: 'n' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const cmd = positionals[0] || 'list';
  const root = repoRoot(process.cwd());
  if (!root) throw new Error('not inside a git repository');

  if (cmd === 'restore') {
    if (positionals[1] === 'list' || values.json) {
      const b = batches(root);
      if (values.json) console.log(JSON.stringify(b, null, 2));
      else for (const x of b) console.log(`${x.batch}  ${x.files.length} file(s)`);
      return 0;
    }
    const r = restore(root, positionals[1]);
    console.log(`${green('✓')} restored ${r.restored.length} file(s) from ${r.batch}`);
    if (r.conflicts.length) console.log(`${yellow('!')} not restored, a file with that name exists again: ${r.conflicts.join(', ')}`);
    return 0;
  }
  if (cmd === 'install-hook') {
    const r = installHook(root, hookCommand());
    console.log(`${green('✓')} ${r.status}: ${r.file}`);
    return 0;
  }

  const res = analyze(root, { since: parseSince(values.since || '30d'), stagedOnly: cmd === 'check' && values.staged });
  const pick = (c) => c.verdict === 'litter' || (values['include-maybe'] && c.verdict === 'maybe');
  const targets = res.candidates.filter(pick);

  if (cmd === 'list') {
    if (values.json) console.log(JSON.stringify(res, null, 2));
    else printList(res, values);
    return 0;
  }
  if (cmd === 'check') {
    const hits = values.staged ? targets.filter((c) => c.status === 'staged') : targets;
    if (values.json) console.log(JSON.stringify(hits, null, 2));
    else if (hits.length) {
      console.error(`${red('agent-litter:')} ${hits.length} file(s) look like agent scratch files:`);
      for (const c of hits) console.error(`  ${c.path}  ${dim(c.reasons.filter((r) => r.points > 0).map((r) => r.text).join('; '))}`);
      console.error(dim(values.staged ? '  unstage them (git restore --staged <file>) or commit with --no-verify if they are intended' : '  run "agent-litter clean" to move them aside'));
    }
    return hits.length ? 1 : 0;
  }
  if (cmd === 'clean' || cmd === 'ignore') {
    if (!targets.length) {
      console.log(`${green('✓')} nothing to ${cmd}`);
      return 0;
    }
    for (const c of targets) console.log(`  ${TAG[c.verdict]} ${c.path}`);
    if (values['dry-run']) {
      console.log(dim(`--dry-run: would ${cmd === 'clean' ? (values.delete ? 'delete' : 'move') : 'ignore'} ${targets.length} file(s)`));
      return 0;
    }
    const files = targets.map((c) => c.path);
    if (cmd === 'ignore') {
      const added = addToExclude(root, files);
      console.log(`${green('✓')} added ${added.length} path(s) to .git/info/exclude`);
      return 0;
    }
    if (targets.some((c) => c.status === 'staged')) {
      console.log(yellow('  some files are staged; they will be unstaged when moved (git sees them as deleted additions)'));
    }
    if (!values.yes && !(await confirm(`${values.delete ? 'Delete' : 'Move'} ${files.length} file(s)? [y/N] `))) {
      if (!process.stdin.isTTY) console.error('refusing without a terminal to confirm; pass --yes');
      return 1;
    }
    const r = clean(root, files, { del: values.delete });
    console.log(values.delete ? `${green('✓')} deleted ${files.length} file(s)` : `${green('✓')} moved ${files.length} file(s) to ${r.dir}\n  undo: agent-litter restore`);
    return 0;
  }
  throw new Error(`unknown command "${cmd}" (try --help)`);
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e) => {
    console.error(`agent-litter: ${e.message}`);
    process.exitCode = 2;
  },
);
