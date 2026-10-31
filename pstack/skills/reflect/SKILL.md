---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, find this conversation's own transcript where this thread's host keeps it. Do not search other projects' transcripts. That crosses workspace boundaries and reads private chats from unrelated projects.

On Claude Code, run the finder with this session's ID, this project's transcripts directory, and a fragment of the conversation's opening user prompt:

```bash
node "<plugin root>/skills/reflect/scripts/find-transcript.mjs" --session "$CLAUDE_CODE_SESSION_ID" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<encoded-cwd>" "<opening prompt fragment>"
```

`<plugin root>` is the directory that holds this plugin's `skills/`, and `<encoded-cwd>` is what `node -p 'process.cwd().normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-")'` prints in the directory Claude Code started in, which is that directory's physical path with every character other than an ASCII letter or digit turned into `-`. If the result is longer than 200 characters, Claude Code keeps the first 200 and appends `-` and a hash, so use the folder under `projects/` whose name starts with those 200 characters and that holds this session's transcript. With the session ID set, the finder prints this session's own transcript, and exits 1 when it does not exist, because a scan could return a sibling session that shares the opening prompt. Without it, the finder scans the flat, nested, and subagent layouts newest first and prints the first transcript whose opening typed prompt carries the fragment. Do not reimplement the scan by hand.

On Codex, pass this thread's ID, which Codex exports as `CODEX_THREAD_ID`, to the resolver, and never search by chat title or time:

```bash
"<plugin root>/skills/poteto-mode/scripts/resolve-codex-transcript" "$CODEX_THREAD_ID"
```

On success it exits 0 and prints JSON whose `path` is the transcript. If either command exits non-zero, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

One response, three `delegate_task` calls with `mode: "async"` and full tool access. Reviewers need MCP access to look up the tickets, chat threads, and observability traces the transcript references.

Each reviewer and the synthesizer name a role line in the model sheet and a default. Get each `target` from the `pstack_model` tool with that role name. Omit `target` when it returns `inherit-parent`. Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section of the **poteto-mode** skill.

| Lens | Role line | Default | Prompt template |
|---|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` | default in [Models](#models) | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | default in [Models](#models) | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | default in [Models](#models) | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in their final message, which arrives as the `delegate_task` result.

## 3. Synthesize

One `delegate_task` call with full tool access and `target` from the `reflect judgment, divergent, synthesizer` line (default in [Models](#models)). It spot-verifies citations through MCP. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Never edit a skill under `plugins/cache/`, where the harness keeps installed plugins, such as `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache/` on Claude Code and `${CODEX_HOME:-~/.codex}/plugins/cache/` on Codex. Before approval, show its destination in the project's or the user's skills directory, `.claude/skills/<skill>/` or `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/<skill>/` on Claude Code, or `.agents/skills/<skill>/` or `~/.agents/skills/<skill>/` on Codex. After approval, copy the skill folder there and edit the copy. Never open a PR or push.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the harness's skill-authoring skill (`skill-creator` where installed) and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to `skill-creator` and run its description-optimization loop.
- `new skill via skill-creator: <kebab-name>`: hand creation to `skill-creator`. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.

## Models

Get every target from the `pstack_model` tool. Pass the role name plus the job type and size from the routing table in poteto-mode's Subagents section. This skill's spawns are `research` jobs for tooling and `review` jobs for judgment. Write every brief from `<plugin root>/skills/poteto-mode/brief.md`. Without a job, pass the complexity: `groundwork` for cheap mechanical work, `bounded` for involved but bounded work, `general` for work that needs substantial judgment. The tool reads the role's line in the model sheet (`~/.config/pi-t3-bridge/models.md`, written by `/setup-pstack`). A line naming a model is used as written, moved to a provider T3 can run right now when needed. A role with no line, or `inherit-parent` or `auto`, is routed by this extension's `models.json`: the parent's model family, sized and reasoned by complexity, and for panels one seat per family. Pass each returned target as `delegate_task`'s `target`. `inherit-parent` means omit `target`. `blocked` means the panel cannot reach two model families on this T3, so record its reason.

- reflect tooling: one target
- reflect judgment, divergent, synthesizer: one target
