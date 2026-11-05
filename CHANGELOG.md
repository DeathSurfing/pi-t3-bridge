# Change log

## 0.8.0, 5 November 2026

Version 0.8.0 removes the pi-amplike adapter (`amplike.ts`). The package no longer loads pi-amplike or changes its `/mode`, `/btw`, `/handoff`, and `subagent` for T3. Use T3's own `/btw`, `/side`, model picker, and `delegate_task` instead. If you set `{"source":"npm:pi-amplike","extensions":[]}` for the adapter, remove that entry from `~/.pi/agent/settings.json`.

The bridge no longer rewrites the "- Subagents:" bullet in T3's "## T3 Code orchestration" section, so Pi sends T3's system prompt unchanged. The rewrite broke pi-cached-compaction, which rebuilds the last request and compares it byte for byte before it reuses the prompt cache. Every cached compaction in T3 failed with `request field "system" differs`. Pi now sees T3's original bullet, which names Claude's `Agent` and Codex's `spawn_agent`. Pi has neither tool.

## 0.7.2, 5 November 2026

Version 0.7.2 stops pi-amplike's permission prompt in T3 threads. T3 has its own permission system, so the bridge no longer loads amplike's `permissions` extension inside T3, and Pi no longer asks "Permission required ... Allow?" before bash commands there. Outside T3, amplike's `/permissions` and its prompts work as before.

## 0.7.1, 4 November 2026

Version 0.7.1 changes only the documentation. The README now covers all four extensions and the pi-amplike adapter, and the package now ships this change log.

## 0.7.0, 4 November 2026

Version 0.7.0 builds and checks every schema with `@earendil-works/pi-schema` instead of `typebox`, because Pi 1.5.0 moved its own schemas and tool checks to pi-schema. The package now lists pi-schema as a dependency, and it no longer needs `typebox`.

The behavior stays the same for a person who uses the package. A schema that reads data from T3, a settings file, or a model still accepts fields it doesn't know, as it did with `typebox`. Tools now send a list of allowed words to the model as `enum` instead of `anyOf`, and the model can send the same values as before.

## 0.6.0, 4 November 2026

Version 0.6.0 adds `amplike.ts`, which loads pi-amplike's extensions and changes the parts that T3 can't show. In a T3 thread, amplike's `subagent` tool is off, so subagent work goes through T3's `delegate_task`. `/btw` starts a `delegate_task` child, and `/handoff` and the `handoff` tool start a new T3 thread with a summary and the parent session file. `/mode` sends each model change to T3, so T3's model picker shows the same model.

To use the adapter, change `"npm:pi-amplike"` in `~/.pi/agent/settings.json` to `{"source":"npm:pi-amplike","extensions":[]}`. Outside T3, amplike works as before.

## 0.5.0, 4 November 2026

Version 0.5.0 lets the stop checks use any chat model when Jev isn't available. You can name the model with `classifierModel` in `~/.config/pi-t3/config.json`, and without the setting the bridge uses Jev when you have access and the session model when you don't. The release also updates pstack to t3-pstack 2.2.1, and it pins T3 to 0.1.7.

## 0.4.0, 2 November 2026

Version 0.4.0 adds a second set of skills to the package, and the package now serves the pstack skills in a new way. The sections below describe each change and the benefit of the change.

### Skills from tstack

The package now includes the skills from tstack, a public set of skills by Theo Browne. The nine skills are babysit-pr, council, file-pr, full-send, full-stop, leaving-pr-comments, modernize, sol-loop, and takeover, and a new file named tstack.ts serves the skills to Pi. The tstack.ts file works on its own, so the skills stay available when a person turns the pstack part of the package off.

The benefit is that a person gets the skills with the package and does not copy skill folders into a personal skills folder by hand. Updates to the skills arrive with package updates, so a person does not keep a separate copy up to date.

### How the package serves pstack

The pstack folder now holds the exact text from the pstack project, and a new folder named overlay holds every change that Pi needs. At start, the package copies pstack into a folder in the state directory and applies the changes from overlay to the copy, and Pi reads the copy.

The benefit is that an update from the pstack project needs no work to combine the update with the changes for Pi. A maintainer takes the new text as it comes, and the test run fails with the name of the file when a change in overlay no longer matches the new text.

### What a person needs to do

A person who copied the tstack skills into a personal skills folder can delete the copies, because the package now serves the same skills and two copies of one skill can conflict. A person who did not copy the skills needs to do nothing, and the pstack skills work as before.
