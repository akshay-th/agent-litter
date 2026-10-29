import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAY, git, setup, tool, writeClaude } from './fixtures.js';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

function scenario() {
  const s = setup();
  const { home, repo } = s;
  const files = {
    'debug_auth.py': 'print("debug")\n',
    'IMPLEMENTATION_SUMMARY.md': '# Summary\n',
    'out.log': 'ok\n',
    'src/feature.ts': 'export const feature = () => 1;\n',
    'src/index.ts.bak': 'old\n',
  };
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(repo, rel), body);
  writeFileSync(join(repo, 'my-own-notes.txt'), 'not from an agent\n');
  writeClaude(home, repo, 'sess-1', [
    [DAY, tool('Write', { file_path: join(repo, 'debug_auth.py'), content: '' })],
    [DAY - 10, tool('Bash', { command: 'python debug_auth.py > out.log' })],
    [DAY - 20, tool('Write', { file_path: join(repo, 'IMPLEMENTATION_SUMMARY.md'), content: '' })],
    [DAY - 30, tool('Write', { file_path: join(repo, 'src/feature.ts'), content: '' })],
    [DAY - 40, tool('Bash', { command: 'cp src/index.ts src/index.ts.bak' })],
  ]);
  return s;
}

function run(s, args, input) {
  const env = { ...process.env, HOME: s.home, USERPROFILE: s.home, NO_COLOR: '1' };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: s.repo, env, encoding: 'utf8', input });
}

test('list classifies agent files and ignores the human one', () => {
  const s = scenario();
  const r = run(s, ['list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const verdicts = Object.fromEntries(out.candidates.map((c) => [c.path, c.verdict]));
  assert.deepEqual(verdicts, {
    'debug_auth.py': 'litter',
    'IMPLEMENTATION_SUMMARY.md': 'litter',
    'out.log': 'litter',
    'src/index.ts.bak': 'litter',
    'src/feature.ts': 'keep',
  });
  const text = run(s, []).stdout;
  assert.match(text, /4 litter, 0 maybe/);
  assert.doesNotMatch(text, /my-own-notes/);
});

test('check exits 1 while litter is present', () => {
  const s = scenario();
  const r = run(s, ['check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /4 file\(s\) look like agent scratch files/);
});

test('clean moves litter into .git/agent-litter and restore brings it back', () => {
  const s = scenario();
  assert.equal(run(s, ['clean']).status, 1, 'refuses without --yes and no TTY');
  assert.match(run(s, ['clean', '-n']).stdout, /would move 4 file\(s\)/);
  assert.ok(existsSync(join(s.repo, 'debug_auth.py')));

  const r = run(s, ['clean', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /moved 4 file\(s\) to \.git[\\/]agent-litter[\\/]\S+$/m);
  for (const f of ['debug_auth.py', 'IMPLEMENTATION_SUMMARY.md', 'out.log', 'src/index.ts.bak']) assert.ok(!existsSync(join(s.repo, f)), f);
  assert.ok(existsSync(join(s.repo, 'src/feature.ts')));
  assert.ok(existsSync(join(s.repo, 'my-own-notes.txt')));
  assert.equal(git(s.repo, 'status', '--porcelain').includes('agent-litter'), false);
  assert.equal(run(s, ['check']).status, 0);

  const back = run(s, ['restore']);
  assert.match(back.stdout, /restored 4 file\(s\)/);
  assert.equal(readFileSync(join(s.repo, 'debug_auth.py'), 'utf8'), 'print("debug")\n');
});

test('ignore writes .git/info/exclude', () => {
  const s = scenario();
  run(s, ['ignore']);
  const ex = readFileSync(join(s.repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(ex, /^\/debug_auth\.py$/m);
  assert.match(ex, /^\/IMPLEMENTATION_SUMMARY\.md$/m);
  assert.equal(git(s.repo, 'status', '--porcelain', '--untracked-files=all').includes('debug_auth.py'), false);
  assert.match(run(s, ['ignore']).stdout, /nothing to ignore/, 'excluded files are no longer candidates');
});

test('check --staged only looks at staged files; install-hook wires it up', () => {
  const s = scenario();
  assert.equal(run(s, ['check', '--staged']).status, 0, 'nothing staged yet');
  git(s.repo, 'add', 'IMPLEMENTATION_SUMMARY.md', 'src/feature.ts');
  const r = run(s, ['check', '--staged']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /IMPLEMENTATION_SUMMARY\.md/);
  assert.doesNotMatch(r.stderr, /debug_auth/);

  const h = run(s, ['install-hook']);
  assert.match(h.stdout, /created: \.git[\\/]hooks[\\/]pre-commit$/m);
  const hook = readFileSync(join(s.repo, '.git', 'hooks', 'pre-commit'), 'utf8');
  assert.match(hook, /check --staged/);
  assert.match(run(s, ['install-hook']).stdout, /already-installed/);
});

test('outside a git repo', () => {
  const s = setup();
  const r = spawnSync(process.execPath, [CLI], { cwd: s.home.replace(/home$/, ''), encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: s.base } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not inside a git repository/);
});

test('header shortens a repo under HOME to ~', () => {
  const s = setup();
  const r = spawnSync(process.execPath, [CLI], { cwd: s.repo, encoding: 'utf8', env: { ...process.env, HOME: s.base, USERPROFILE: s.base, NO_COLOR: '1' } });
  assert.match(r.stdout, new RegExp(`^~${s.repo.slice(s.base.length).replace(/\\/g, '\\\\')} · 0 session`));
});
