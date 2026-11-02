---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
disable-model-invocation: true
---

# How

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem, enough to build a working mental model, not so much that it reads like annotated source code.

Every spawn is a `delegate_task` child with `role: "research"` and a brief that says to inspect only and change no file. Explorers use the `how explorer` line in the model sheet (default in [Models](#models)), and every explainer uses the `how explainer` line (default in [Models](#models)). Get each `target` from the `pstack_model` tool with that role name. Omit `target` when it returns `inherit-parent`. Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section of the **poteto-mode** skill.

## 1. Assess complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

- **Simple** (a single module, a small utility, a narrow question such as "how does function X work"): no explorers. Spawn one explainer that explores and explains in one pass, built from `references/explainer-prompt.md` without the explorer-findings section. Go to step 4.
- **Complex** (a subsystem spanning multiple files or services, a cross-cutting feature, a full architectural overview): go to step 2.

When in doubt, take the simple path.

## 2. Explore (complex only)

Decompose the question into 2 to 4 angles, each a distinct slice of the subsystem. Spawn all explorers in a single message, each with `references/explorer-prompt.md` and its angle filled in.

## 3. Synthesize (complex only)

Once all explorers have returned, spawn one explainer with `references/explainer-prompt.md` and every explorer's findings filled in.

## 4. Present

Present the explainer's output. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.

## Output format

The explanation uses the sections defined in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.

## Models

Get every target from the `pstack_model` tool. Pass the role name plus the job type and size from the routing table in poteto-mode's Subagents section. This skill's spawns are `research` jobs, size S or M. Write every brief from `<plugin root>/skills/poteto-mode/brief.md`: the extension refuses a `delegate_task` call whose brief is missing its sections or limits. Without a job, pass the complexity: `groundwork` for cheap mechanical work, `bounded` for involved but bounded work, `general` for work that needs substantial judgment. The tool reads the role's line in the model sheet (`~/.config/t3-pstack/models.md`, written by `/setup-pstack`). A line naming a model is used as written, moved to a provider T3 can run right now when needed. A role with no line, or `inherit-parent` or `auto`, is routed by this extension's `models.json`: the parent's model family, sized and reasoned by complexity, and for panels one seat per family. The extension blocks a `delegate_task` call that uses the reserved Fable model or fast mode unless the user named it, reasoning above what `pstack_model` returned, or reasoning above high unless the user's latest message is "allow xhigh". Pass each returned target as `delegate_task`'s `target`. `inherit-parent` means omit `target`. `blocked` means the panel cannot reach two model families on this T3, so record its reason.

- how explorer: one target
- how explainer: one target
