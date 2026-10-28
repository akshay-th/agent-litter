# agent-litter

**Find the scratch files your AI coding agent left in the repo before they get committed, using the agent's own session transcripts as evidence.**

After a long session with Claude Code, Codex or Gemini CLI, `git status` tends to fill up with things like these:

```
?? IMPLEMENTATION_SUMMARY.md
?? debug_auth.py
?? test_output.txt
?? check_db.py
?? src/app.ts.bak
?? out.log
```

Some of those files are real work, and some are throwaway: debug scripts, one-off test runners, `*_SUMMARY.md` reports written for the chat, `.bak` copies. Pattern-based cleaners can only guess, and `git clean` deletes your own files too.

`agent-litter` reads the transcripts the agents already keep on disk to learn **which files the agent created**. It sees `Write` / `apply_patch` / `write_file` calls, shell redirections like `> out.log`, `cp`/`touch`/`tee`/`curl -o`, and scripts the agent ran. It only ever considers those files, then scores each one:

```
$ agent-litter
~/work/app · 3 session(s) from Claude Code, Codex
litter debug_auth.py
       Claude Code, created with Write, 2h ago · session 66dfd150
       +2 scratch-style file name
       +2 agent ran it as a one-off: python debug_auth.py > out.log
       +1 loose script in the repo root
litter IMPLEMENTATION_SUMMARY.md
       Claude Code, created with Write, 2h ago · session 66dfd150
       +3 status/summary document written for the chat
litter out.log
       Claude Code, created by a shell command, 2h ago · session 66dfd150
       +1 output / dump file type
       +1 ...
litter src/index.ts.bak
       Codex, created by a shell command, 1d ago · session 019a2c1e
       +3 backup / temp file extension

4 litter, 0 maybe. agent-litter clean moves litter to .git/agent-litter/ (undo: agent-litter restore).
```

Files the agent created that look intentional are kept, for example `src/feature.ts`, which a tracked file imports. Files you created yourself never show up.

## Install

```bash
npm install -g github:akshay-th/agent-litter
# or
npx -y github:akshay-th/agent-litter
```

It has no dependencies and needs Node 18.3+ and git.

## Commands

| Command | |
|---|---|
| `agent-litter` / `list` | Show litter and maybe files. `--all` also shows the ones that look intentional, `--json` gives machine-readable output. |
| `agent-litter clean` | Move litter into `.git/agent-litter/<batch>/`. Git never tracks that directory, and the move can be undone. Use `-m` to include *maybe* files, `--delete` to delete outright, `-n` to preview and `-y` to skip the prompt. |
| `agent-litter restore [batch]` | Put the last cleaned batch back. `restore list` shows batches. |
| `agent-litter ignore` | Add litter to `.git/info/exclude`, a local ignore list that is never committed. |
| `agent-litter check [--staged]` | Exit 1 if litter is present. With `--staged`, only staged new files are checked. |
| `agent-litter install-hook` | Add `check --staged` to `.git/hooks/pre-commit`. If a hook already exists, it is appended to. |

`--since 7d` limits which sessions are read (default: 30 days).

### Pre-commit hook

```bash
agent-litter install-hook
git add -A && git commit -m "feature"
# agent-litter: 2 file(s) look like agent scratch files:
#   IMPLEMENTATION_SUMMARY.md  status/summary document written for the chat
#   check_db.py  scratch-style file name; agent ran it as a one-off: python check_db.py
#   unstage them (git restore --staged <file>) or commit with --no-verify if they are intended
```

## Where the evidence comes from

| Agent | Transcripts | What's used |
|---|---|---|
| Claude Code | `~/.claude/projects/<encoded cwd>/*.jsonl` (`$CLAUDE_CONFIG_DIR`). This includes sessions started in a subdirectory or a parent directory that wrote into the repo. | `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash` |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` (`$CODEX_HOME`), matched on `session_meta.cwd` | `apply_patch` (`*** Add File:`), `shell` / `exec_command` |
| Gemini CLI | `~/.gemini/tmp/<sha256(project root)>/**/*.json` | `write_file`, `replace`, `run_shell_command` |

Sometimes a file was produced by a script the agent ran, so no write appears in the transcript. In that case the file still counts as agent-created if it **appeared while a session was active**, give or take a minute.

## Scoring

| Signal | Points |
|---|---|
| `*SUMMARY*.md`, `*REPORT*.md`, `*PLAN*.md`, `*FIXES*.md`, `*ANALYSIS*.md`, … | +3 |
| `.bak` `.orig` `.old` `.tmp` `.swp` `.rej` `~` `_old` `_backup` `_copy` | +3 |
| Scratch name: `tmp_`, `debug_`, `scratch`, `repro`, `playground`, `test_output`…; `check_`, `verify_`, `quick`, `output`… outside source dirs | +2 |
| Inside `tmp/`, `scratch/`, `debug/`, `playground/` | +2 |
| The agent executed it (`python x.py`, `node x.js`, `./x.sh`), outside source dirs | +2 |
| Loose script in the repo root; root-level `test_*.py` outside test dirs; output types (`.log` `.out` `.csv` `.dump`); empty file | +1 |
| Mentioned by a tracked file (import path, `import x`, file name) | −3 |
| Lives in `tests/` / `__tests__/` / `spec/` | −2 |
| The agent kept editing it after creating it | −1 |

A score of **2 or more** means *litter*, **1** means *maybe*, and **0 or less** means *keep*. When in doubt, `clean` only moves files, so `restore` gets them back.

## License

MIT
