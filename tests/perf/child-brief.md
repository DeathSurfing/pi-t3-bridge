# Task: perf probe child

Job: implement · Size: S · Time limit: 30 min · Disk limit: 100 MB Workdir: the checkout you start in. Run every command there and edit by absolute path.

## Goal

Probe only.

## Acceptance command

```sh
false
```

Run it before you report. Don't edit it or the files it reads: none.

## Files you may write

- .scratch/probe.txt Everything else is read-only. Tool caches (~/.cache, ~/.npm, ~/.local/share/uv) are allowed. Scratch goes in .scratch/ and you delete it before you report.

## Non-goals

- Anything.
- Commits: none. No new dependencies or lockfile edits unless listed above.

## Context

- /tmp: none.

## Stop conditions

Stop and report BLOCKED when: the acceptance command can't pass without writing outside the list; a fact in this brief is wrong; you hit the time or disk limit; the same failure happens 3 times. Don't work around a stop condition.

## Report

STATUS: PASS | ISSUES | BLOCKED ACCEPTANCE: `<command>` -> exit <code>, last 10 lines of output FILES: output of `git status --porcelain` DISK: `du -sk .` and anything you created outside the workdir ISSUES or BLOCKED: one line each with file:line and the command that shows it
