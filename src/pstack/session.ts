import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { PstackPaths } from "./resources.ts";

const SESSION_HOOK_OFF = /^session hook:\s*off\s*$/mu;

const configHome = (): string =>
  process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");

export const modelSheetPath = (): string =>
  path.join(configHome(), "pi-t3-bridge", "models.md");

// Releases before the rename kept the sheet under t3-pstack. The first load
// after the rename moves it once. A symlinked sheet gets a new link to its
// resolved target, since a relative link would dangle once moved. A failed
// move leaves both alone.
export const moveOldSheet = (): void => {
  const old = path.join(configHome(), "t3-pstack", "models.md");
  const sheet = modelSheetPath();

  if (existsSync(sheet) || !existsSync(old)) {
    return;
  }

  try {
    mkdirSync(path.dirname(sheet), { recursive: true });

    if (lstatSync(old).isSymbolicLink()) {
      symlinkSync(realpathSync(old), sheet);
      unlinkSync(old);
    } else {
      renameSync(old, sheet);
    }
  } catch {
    // Routing falls back to the defaults instead.
  }
};

export const sessionHookEnabled = (): boolean => {
  const sheetPath = modelSheetPath();

  if (!existsSync(sheetPath)) {
    return true;
  }

  return !SESSION_HOOK_OFF.test(readFileSync(sheetPath, "utf-8"));
};

// Upstream's hook text is written for Claude Code and Codex. Each pair
// rewrites a part that reads differently on Pi, where pstack_model reads the
// model sheet and no shell output budget cuts a SKILL.md.
const PI_REWRITES: readonly (readonly [string, string])[] = [
  ["You have t3-pstack,", "You have pi-t3-bridge,"],
  ["t3-pstack:poteto-mode", "/skill:poteto-mode"],
  [
    " On Codex, open its SKILL.md whole, in a shell call of its own with `max_output_tokens: 10000`, since a smaller budget cuts out its middle.",
    " Read its SKILL.md in full before you act.",
  ],
  [
    "This runs on T3: before the first subagent or panel in a session, read the model sheet, `~/.config/t3-pstack/models.md` (`$XDG_CONFIG_HOME/t3-pstack/models.md` when that is set), or `t3-pstack-models.md` in this host's config directory when that file is missing. This chat runs the playbook itself. A step it says to delegate goes through `delegate_task` to that role's sheet entry,",
    "This chat runs the playbook itself. A step it says to delegate goes through `delegate_task` with a target from `pstack_model`,",
  ],
];

export const sessionGuidance = (paths: PstackPaths): string => {
  const contextPath = path.join(
    paths.pstackRoot,
    "hooks",
    "session-start-context.md"
  );

  const upstreamGuidance = existsSync(contextPath)
    ? readFileSync(contextPath, "utf-8").trim()
    : "You have pi-t3-bridge, pstack for T3 Code.";

  let piGuidance = upstreamGuidance;

  for (const [from, to] of PI_REWRITES) {
    piGuidance = piGuidance.replaceAll(from, to);
  }

  return [
    piGuidance,
    "",
    "Pi notes:",
    `- The pstack root is ${paths.pstackRoot}. Read skill and agent files there when a skill names a plugin root.`,
    "- The session task tool is `tasks`. Keep the playbook todolist there and send the complete list on every change, with stable step ids and at most one step in_progress.",
    "- When a workflow needs the transcript, use the `transcript` tool, not the Claude Code or Codex finders.",
    "- When a plan needs the user's approval before edits, call the `plan` tool.",
  ].join("\n");
};
