import test from 'node:test';
import assert from 'node:assert/strict';
import { needlesFor, scoreFile } from '../src/score.js';

const v = (rel, ctx = {}) => scoreFile(rel, { root: '/nonexistent', evidence: [{ kind: 'write' }], ...ctx }).verdict;

test('classic agent litter', () => {
  for (const rel of [
    'IMPLEMENTATION_SUMMARY.md',
    'FIX_REPORT.md',
    'docs/REFACTOR_PLAN.md',
    'debug_auth.py',
    'test_output.txt',
    'tmp/scratch.js',
    'src/app.ts.bak',
    'server.js.orig',
    'repro-issue-42.ts',
    'check_db.py',
  ]) {
    assert.equal(v(rel), 'litter', rel);
  }
});

test('real project files are kept', () => {
  for (const rel of ['src/check.ts', 'src/output/format.ts', 'lib/validate.js', 'tests/test_auth.py', 'README.md', 'src/components/Button.tsx', 'CHANGELOG.md', 'index.js']) {
    assert.equal(v(rel), 'keep', rel);
  }
});

test('references and test dirs pull the score down', () => {
  assert.equal(v('check_db.py'), 'litter');
  assert.equal(v('check_db.py', { referenced: ['Makefile', 'README.md'] }), 'keep');
  const r = scoreFile('verify.py', { root: '/x', evidence: [{ kind: 'write' }], ranBy: ['python verify.py'] });
  assert.equal(r.verdict, 'litter');
  assert.ok(r.reasons.some((x) => /ran it as a one-off/.test(x.text)));
});

test('running your own CLI from src/bin is not a litter signal', () => {
  assert.equal(v('bin/cli.js', { ranBy: ['node bin/cli.js --all'] }), 'keep');
});

test('loose root scripts are a "maybe" on their own', () => {
  assert.equal(v('migrate_users.py'), 'maybe');
});

test('needles cover import styles', () => {
  assert.deepEqual(needlesFor('src/utils/helper.ts'), ['helper.ts', "/helper'", '/helper"', '/helper.']);
  assert.deepEqual(needlesFor('pkg/db_tools.py'), ['db_tools.py', 'import db_tools', 'from db_tools ', '.db_tools import']);
  assert.deepEqual(needlesFor('NOTES.md'), ['NOTES.md']);
});
