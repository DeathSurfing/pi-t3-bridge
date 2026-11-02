---
name: interrogate
description: "Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", or \"tear this apart\". Adversaries try to break a change or design, and only findings proven by a run survive."
disable-model-invocation: true
---

# Interrogate

Adversaries try to break a change or a design. A finding survives only when a run proves it. Report the findings. Do not apply fixes.

## Frame

The scope is what the user names. Otherwise it is the branch diff from its merge base with the base branch, through the working tree. State the intent with the **in-your-own-words** skill, from the user's message, the commits, and the PR description. Ask the user when the intent is unclear.

## Fan out

Run Phase A steps 3 and 4 and Phase B of the **arena** skill, with four changes. Call `pstack_model` with `interrogate reviewers` in place of `arena runners`, and if it returns `blocked`, record its reason as `BLOCKED: independent review`. Copy the scope's uncommitted changes into each worktree. Spawn each adversary as a `delegate_task` child with `role: "review"` and no persona brief. In place of the arena task and rationale, give each adversary the scope, the intent, and this brief:

> Break this change. Prove each finding with a run against the real code, such as a failing test, a repro script, or command output that shows the wrong behavior. For a design or plan, run a prototype or probe the current tree. Keep repros in your own worktree. Report each finding with a title, the exact command, the output it printed, and the output the intent requires. Leave out anything you did not run. That covers style, naming, structure, and risks that need a future change to matter. No findings is a valid result.

## Verify

Verify each finding per arena Phase F by rerunning its command. Keep a finding when the output shows the failure and the failure breaks the intent. Drop the rest. Merge findings that share a root cause.

Skip arena Phases C, D, and E. Adversaries find different failures, so the verdict keeps every verified finding, not one adversary's list.

## Output

- **Intent**: the restatement.
- **Findings**: for each verified finding, the command, its output, how it breaks the intent, and the adversaries that found it. Say "no verified findings" when none survive.
- **Dropped**: for each adversary, the count of dropped findings and why.

## Models

Get every target from the `pstack_model` tool. Pass the role name plus the job type and size from the routing table in poteto-mode's Subagents section. This skill's spawns are `review` jobs, size S or M. Write every brief from `<plugin root>/skills/poteto-mode/brief.md`: the extension refuses a `delegate_task` call whose brief is missing its sections or limits. Without a job, pass the complexity: `groundwork` for cheap mechanical work, `bounded` for involved but bounded work, `general` for work that needs substantial judgment. The tool reads the role's line in the model sheet (`~/.config/t3-pstack/models.md`, written by `/setup-pstack`). A line naming a model is used as written, moved to a provider T3 can run right now when needed. A role with no line, or `inherit-parent` or `auto`, is routed by this extension's `models.json`: the parent's model family, sized and reasoned by complexity, and for panels one seat per family. The extension blocks a `delegate_task` call that uses the reserved Fable model or fast mode unless the user named it, reasoning above what `pstack_model` returned, or reasoning above high unless the user's latest message is "allow xhigh". Pass each returned target as `delegate_task`'s `target`. `inherit-parent` means omit `target`. `blocked` means the panel cannot reach two model families on this T3, so record its reason.

- interrogate reviewers: panel, one seat per model family
