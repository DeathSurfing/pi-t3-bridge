# Delegation brief

Every `delegate_task` brief follows this template. Use the sections and limits to give the child a bounded task. A persona line ("Read `<plugin root>/agents/<name>.md` in full and act as it says") may come before `# Task:`.

Fill each `<...>`. Keep the headings exactly as written.

````markdown
# Task: <one line>
Job: <mechanical | check | research | implement | hard | review | design> · Size: <S | M> · Time limit: <N> min · Disk limit: <N> MB
Workdir: the checkout you start in. Run every command there and edit by absolute path.

## Goal
<2 to 4 sentences: the outcome, not the steps>

## Acceptance command
```sh
<command that exits 0 only when the goal is met, and fails if it checked nothing>
```
Run it before you report. Don't edit it or the files it reads: <test files>.

## Files you may write
- <repo-relative path or narrow glob>
Everything else is read-only. Tool caches (~/.cache, ~/.npm, ~/.local/share/uv) are allowed.
Scratch goes in .scratch/ and you delete it before you report.

## Non-goals
- <what not to do>
- Commits: <none | one commit "msg">. No new dependencies or lockfile edits unless listed above.

## Context
- <absolute path>: <why it matters>

## Stop conditions
Stop and report BLOCKED when: the acceptance command can't pass without writing outside the list;
a fact in this brief is wrong; you hit the time or disk limit; the same failure happens 3 times.
Don't work around a stop condition.

## Report
STATUS: PASS | ISSUES | BLOCKED
ACCEPTANCE: `<command>` -> exit <code>, last 10 lines of output
FILES: output of `git status --porcelain`
DISK: `du -sk .` and anything you created outside the workdir
ISSUES or BLOCKED: one line each with file:line and the command that shows it
````

## Sizes

- **S**: 30 min or less, 5 files or fewer, one acceptance command.
- **M**: 90 min or less, 15 files or fewer.
- **L**: anything bigger. Split it into S and M tasks, or do it yourself.

## The acceptance command

- For `mechanical`, `implement` and `hard` jobs it must fail before the change. The child's extension runs it first. If it already passes, the child stops with BLOCKED, because the command checks nothing.
- It must fail on wrong work, not only on a crash. A script that compares nothing and exits 0 is not an acceptance command. Pass the arguments it needs, and assert on its output when it prints a verdict.
- A read-only job writes no files: list `- none` under "Files you may write". Its acceptance command checks the report exists or reruns the commands under review.
- Allow the tool caches the command needs. A brief that forbids `~/.cache/uv` stops `uv sync`.

## What the child's extension enforces

The child's own pstack extension reads this brief from its first message and enforces it, whatever the model does:

- Every shell command runs in a macOS sandbox that can write only to the workdir, its git directory, the tool caches and the system temp folder.
- `write` and `edit` only touch the listed files and `.scratch/`.
- Shell timeouts stop at the time limit. After it, or past the disk limit, every tool is refused and the child can only report.
- When the child ends its turn, the extension reruns the acceptance command, `git status` and `du`, and appends a "Checked by pi-t3-bridge" block with the real exit codes and STATUS. It also writes a ledger line to `~/.local/state/pi-t3/ledger.jsonl`.

## GPT rules

For GPT work, prefer size S, a worktree for writing tasks, and async mode. Follow the user's instructions when they differ.
