# Change log

## Unreleased

The README and the change log were rewritten in plain language, and the README now has a section on the child sandbox with a tree of the folders a child can write.

The notes in `brief.md` about the child sandbox moved from `pstack/` into `overlay/`, so `pstack/` holds the upstream text again and the next upstream merge won't conflict with them. Agents read the same notes as before.

## 0.8.3, 6 November 2026

Version 0.8.3 fixes six problems that a large orchestration run found in the child sandbox, and it changes how often the stop checks send a note.

The child sandbox has these changes:

- A bullet under "Files you may write" may list several paths, and every word with a slash or a glob counts as a path. Before, the bridge kept only the first word, so a child was refused a file its brief meant to allow.
- The disk limit leaves out `node_modules`, because pnpm fills it from the store. Before, a 500 MB limit failed on any pnpm monorepo install.
- On Linux the child runs in its own process namespace, so it can't see or signal processes on the host. Anything a command starts in the background ends when that command ends.
- The bridge sets `TMPDIR` in the child. The README now says that Chrome and Electron need `--no-sandbox` inside the sandbox, and that a `pi` run inside a child needs `PI_CODING_AGENT_DIR`.

The stop checks now send at most one note for each prompt. When a check would send a second note for the same prompt, the bridge logs it in `steer.jsonl` as capped, where earlier releases showed a toast.

## 0.8.2, 6 November 2026

Version 0.8.2 closes a hole in the child sandbox. A delegated child whose brief missed a section or a header field ran with no sandbox and no limits, because the bridge treated it as your own session, and such a child could rewrite the parent's git hooks.

The bridge now blocks every tool in that child, and the block lists what the brief is missing, so the parent can send a complete brief. A session you start yourself is never blocked, even when its first message starts with `# Task:`.

## 0.8.1, 6 November 2026

Version 0.8.1 lets a delegated child run `pnpm install` and `git commit` in a repo that uses pnpm and lefthook, under `bwrap` on Linux and `sandbox-exec` on macOS.

Each child gets its own `XDG_RUNTIME_DIR` in the temp folder, because pnpm 12 takes its store lock there. The sandbox can write to the store that `pnpm store path` names for the workdir, and the child uses that store, so the child shares the parent's store and doesn't build a second one in the workdir.

Children skip install scripts, so a root `prepare` such as `lefthook install` no longer fails on the read-only git hooks. With the same setting, npm also skips the `pre` and `post` scripts of `npm run`, while pnpm still runs them. A brief that needs a postinstall step, e.g. `next typegen`, should name the build or typecheck that runs the step.

## 0.8.0, 5 November 2026

Version 0.8.0 removes the pi-amplike adapter, `amplike.ts`. The package no longer loads pi-amplike or changes its `/mode`, `/btw`, `/handoff`, and `subagent` for T3, so use T3's own `/btw`, `/side`, model picker, and `delegate_task` instead. If you set `{"source":"npm:pi-amplike","extensions":[]}` for the adapter, remove that entry from `~/.pi/agent/settings.json`.

The bridge also stops rewriting the "- Subagents:" bullet in the "## T3 Code orchestration" section of T3's system prompt, so Pi sends the prompt unchanged. The rewrite broke pi-cached-compaction, which compares the last request byte for byte before it reuses the prompt cache, and every cached compaction in T3 failed with `request field "system" differs`. Pi now sees T3's original bullet, which names Claude's `Agent` and Codex's `spawn_agent`, although Pi has neither tool.

## 0.7.2, 5 November 2026

Version 0.7.2 stops pi-amplike's permission prompt in T3 threads. T3 has its own permission system, so the bridge no longer loads amplike's `permissions` extension inside T3, and Pi no longer asks "Permission required ... Allow?" before bash commands there. Outside T3, amplike's `/permissions` and its prompts work as before.

## 0.7.1, 4 November 2026

Version 0.7.1 changes only the documentation. The README covers all four extensions and the pi-amplike adapter, and the package ships the change log.

## 0.7.0, 4 November 2026

Version 0.7.0 builds and checks every schema with `@earendil-works/pi-schema` instead of `typebox`, because Pi 1.5.0 moved its own schemas and tool checks to pi-schema. The package lists pi-schema as a dependency and no longer needs `typebox`.

The package behaves the same for you. A schema that reads data from T3, a settings file, or a model still accepts fields it doesn't know, as it did with `typebox`. Tools send the model their allowed values as `enum` instead of `anyOf`, and the model can send the same values as before.

## 0.6.0, 4 November 2026

Version 0.6.0 adds `amplike.ts`, which loads pi-amplike's extensions and changes the parts that T3 can't show.

In a T3 thread, amplike's `subagent` tool is off, so subagent work goes through T3's `delegate_task`. `/btw` starts a `delegate_task` child, and `/handoff` and the `handoff` tool start a new T3 thread with a summary and the parent session file. `/mode` sends each model change to T3, so T3's model picker shows the same model.

To use the adapter, change `"npm:pi-amplike"` in `~/.pi/agent/settings.json` to `{"source":"npm:pi-amplike","extensions":[]}`. Outside T3, amplike works as before.

## 0.5.0, 4 November 2026

Version 0.5.0 lets the stop checks use any chat model when Jev isn't available. You can name the model with `classifierModel` in `~/.config/pi-t3/config.json`. Without the setting, the bridge uses Jev when you have access and the session model when you don't. The release also updates pstack to t3-pstack 2.2.1 and pins T3 to 0.1.7.

## 0.4.0, 2 November 2026

Version 0.4.0 adds the tstack skills to the package, and it changes how the package serves the pstack skills.

The tstack skills are a public set by Theo Browne, which are babysit-pr, council, file-pr, full-send, full-stop, leaving-pr-comments, modernize, sol-loop, and takeover. A new file, `tstack.ts`, serves them to Pi, and it works on its own, so the skills stay available when you turn the pstack extension off. You get updates to the skills with package updates, so you don't keep a copy by hand.

The `pstack/` folder now holds the exact text from the pstack project, and a new `overlay/` folder holds every change Pi needs. At start, the package copies `pstack/` into the state folder, applies the changes from `overlay/` to the copy, and serves the copy. A maintainer can take an upstream update as it comes, and the test run fails with the file name when a change in `overlay/` no longer matches the new text.

If you copied the tstack skills into your own skills folder, delete the copies, because two copies of one skill can conflict. Otherwise you don't need to do anything, and the pstack skills work as before.
