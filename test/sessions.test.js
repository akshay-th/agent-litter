import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { claudeDirName, readClaude, readCodex, readGemini } from '../src/sessions.js';
import { DAY, iso, setup, tool, writeClaude, writeCodex, writeGemini } from './fixtures.js';

const summary = (events) => events.map((e) => `${e.kind}:${e.path.split('/repo/')[1] ?? e.path}`).sort();

test('claude: Write/Edit tools, Bash creations and runs, sessions in subdirs and parents', () => {
  const { home, repo, base } = setup();
  writeClaude(home, repo, 's1', [
    [DAY, tool('Write', { file_path: join(repo, 'debug_auth.py'), content: 'print(1)' })],
    [DAY - 1000, tool('Bash', { command: 'python debug_auth.py > out.log' })],
    [DAY - 2000, tool('Edit', { file_path: join(repo, 'src/index.ts'), old_string: 'a', new_string: 'b' })],
  ]);
  writeClaude(home, join(repo, 'src'), 's2', [[DAY, tool('Write', { file_path: 'feature.ts', content: 'export {}' })]]);
  // started in the parent directory, wrote into the repo
  writeClaude(home, base, 's3', [[DAY, tool('Write', { file_path: join(repo, 'PLAN.md'), content: '#' })]]);
  // parent session that never touched the repo: no window
  writeClaude(home, base, 's4', [[DAY, tool('Write', { file_path: join(base, 'elsewhere.txt'), content: '' })]]);

  const { events, windows } = readClaude([repo], { home, env: {} });
  assert.deepEqual(summary(events.filter((e) => e.path.startsWith(repo))), [
    'edit:src/index.ts',
    'ran:debug_auth.py',
    'shell-create:out.log',
    'write:PLAN.md',
    'write:debug_auth.py',
    'write:src/feature.ts',
  ]);
  assert.deepEqual(windows.map((w) => w.session).sort(), ['s1', 's2', 's3']);
});

test('claude: directory name encoding', () => {
  assert.equal(claudeDirName('/Users/me/my.app/web_ui'), '-Users-me-my-app-web-ui');
});

test('claude: --since skips old transcripts', () => {
  const { home, repo } = setup();
  writeClaude(home, repo, 's1', [[DAY, tool('Write', { file_path: join(repo, 'x.py'), content: '' })]]);
  assert.equal(readClaude([repo], { home, env: {}, since: Date.now() + 1000 }).events.length, 0);
});

test('codex: apply_patch adds, shell commands, workdir', () => {
  const { home, repo } = setup();
  writeCodex(home, repo, [
    [DAY, { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: scripts/repro.py\n+print(1)\n*** Update File: README.md\n@@\n*** End Patch' }],
    [DAY, { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'python scripts/repro.py > repro.txt'], workdir: repo }) }],
    [DAY, { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'touch NOTES.md' }) }],
    [DAY, { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['apply_patch', '*** Begin Patch\n*** Add File: tmp/a.txt\n+x\n*** End Patch'] }) }],
  ]);
  const { events, windows } = readCodex([repo], { home, env: {} });
  assert.deepEqual(summary(events), ['edit:README.md', 'ran:scripts/repro.py', 'shell-create:NOTES.md', 'shell-create:repro.txt', 'write:scripts/repro.py', 'write:tmp/a.txt']);
  assert.equal(windows[0].session, 'codex-session-1');
});

test('codex: sessions for other directories are ignored', () => {
  const { home, repo, base } = setup();
  writeCodex(home, join(base, 'other'), [[DAY, { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['touch', 'x'] }) }]]);
  assert.equal(readCodex([repo], { home, env: {} }).events.length, 0);
});

test('gemini: write_file and run_shell_command tool calls', () => {
  const { home, repo } = setup();
  writeGemini(home, repo, [
    { type: 'gemini', timestamp: iso(DAY), toolCalls: [{ name: 'write_file', args: { file_path: join(repo, 'ANALYSIS.md'), content: '#' } }] },
    { type: 'gemini', timestamp: iso(DAY), toolCalls: [{ name: 'run_shell_command', args: { command: 'node quick.js > q.out' } }] },
  ]);
  const { events, windows } = readGemini([repo], { home });
  assert.deepEqual(summary(events), ['ran:quick.js', 'shell-create:q.out', 'write:ANALYSIS.md']);
  assert.equal(windows.length, 1);
});
