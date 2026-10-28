import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/bash.js';

const P = (cmd) => parseCommand(cmd, '/repo');

test('redirections create files, but not /dev/null or fd dups', () => {
  assert.deepEqual(P('python debug.py > out.log 2>&1').creates, ['/repo/out.log']);
  assert.deepEqual(P('npm test >> "test results.txt"').creates, ['/repo/test results.txt']);
  assert.deepEqual(P('cmd 2> err.txt').creates, ['/repo/err.txt']);
  assert.deepEqual(P('make > /dev/null 2>&1').creates, []);
  assert.deepEqual(P('echo hi >&2').creates, []);
});

test('touch, tee, cp/mv destinations, curl -o', () => {
  assert.deepEqual(P('touch a.txt b.txt').creates, ['/repo/a.txt', '/repo/b.txt']);
  assert.deepEqual(P('echo x | tee -a log/run.log').creates, ['/repo/log/run.log']);
  assert.deepEqual(P('cp src/app.ts src/app.ts.bak').creates, ['/repo/src/app.ts.bak']);
  assert.deepEqual(P('mv a.txt dir/').creates, []);
  assert.deepEqual(P('curl -sSL https://x.dev/f.json -o fixture.json').creates, ['/repo/fixture.json']);
});

test('heredoc bodies are not parsed as commands', () => {
  const r = P("cat > notes.md <<'EOF'\nrm -rf / > never.txt\ntouch nope\nEOF");
  assert.deepEqual(r.creates, ['/repo/notes.md']);
});

test('cd changes the base directory for later segments', () => {
  assert.deepEqual(P('cd packages/web && touch x.ts').creates, ['/repo/packages/web/x.ts']);
  assert.deepEqual(P('cd /tmp; touch y').creates, ['/tmp/y']);
});

test('scripts the agent executed', () => {
  assert.deepEqual(P('python3 check_db.py --verbose').runs, ['/repo/check_db.py']);
  assert.deepEqual(P('cd tools && node verify.mjs').runs, ['/repo/tools/verify.mjs']);
  assert.deepEqual(P('uv run scripts/repro.py').runs, ['/repo/scripts/repro.py']);
  assert.deepEqual(P('./run_tests.sh').runs, ['/repo/run_tests.sh']);
  assert.deepEqual(P('FOO=1 bun quick.ts').runs, ['/repo/quick.ts']);
  assert.deepEqual(P('npm run build').runs, []);
});

test('quoted separators do not split commands', () => {
  assert.deepEqual(P('echo "a; touch evil" > ok.txt').creates, ['/repo/ok.txt']);
});
