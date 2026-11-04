import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { btwCommand } from "./btw.ts";
import { handoffCommand, handoffTool } from "./handoff.ts";
import type { LoadModeSpec } from "./package.ts";
import { applyChange, configureThread, currentSelection } from "./selection.ts";
import type { SelectionChange } from "./selection.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

// What a T3 thread gets for each name amplike registers. A missing name is
// registered as amplike wrote it. null drops it.
interface Rules {
  readonly commands: Readonly<Record<string, Command | null>>;
  readonly tools: Readonly<Record<string, Tool | null>>;
}

const t3Rules = (loadModeSpec: LoadModeSpec): Rules => ({
  commands: {
    btw: btwCommand(loadModeSpec),
    handoff: handoffCommand(loadModeSpec),
  },
  tools: {
    handoff: handoffTool(loadModeSpec),
    // T3's delegate_task runs subagents as T3 threads.
    subagent: null,
  },
});

// T3 owns the thread's model. When amplike's /mode switches Pi's model or
// thinking level, the same change goes to T3, so T3's model picker matches and
// T3's next set_model keeps it. amplike awaits setModel before it sets the
// thinking level, so the two calls reach T3 in order.
const mirror = async (change: SelectionChange): Promise<void> => {
  await configureThread(applyChange(await currentSelection(), change));
};

const mirrorThinking = async (thinking: string): Promise<void> => {
  try {
    await mirror({ thinking });
  } catch (error) {
    console.error(`pi-t3: T3 kept its thinking level: ${String(error)}`);
  }
};

// Pi's extension API is a plain object of closures, so a copy with some
// methods replaced behaves like the original for everything else.
export const t3View = (
  pi: ExtensionAPI,
  loadModeSpec: LoadModeSpec
): ExtensionAPI => {
  const rules = t3Rules(loadModeSpec);

  return {
    ...pi,
    registerCommand: (name, options) => {
      const rule = rules.commands[name];

      if (rule !== null) {
        pi.registerCommand(name, rule ?? options);
      }
    },
    // T3 sends Pi no key presses.
    registerShortcut: () => null,
    registerTool: (tool) => {
      const rule = rules.tools[tool.name];

      if (rule !== null) {
        pi.registerTool(rule ?? tool);
      }
    },
    setModel: async (model) => {
      const ok = await pi.setModel(model);

      if (ok) {
        await mirror({ model: `${model.provider}/${model.id}` });
      }

      return ok;
    },
    setThinkingLevel: (level) => {
      pi.setThinkingLevel(level);
      void mirrorThinking(level);
    },
  };
};
