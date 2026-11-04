import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compile, nullable, obj, opt, str } from "@earendil-works/pi-schema";

import { callT3Tool } from "../bridge/t3-http.ts";
import type { LoadModeSpec } from "./package.ts";
import {
  changeFromFlags,
  currentSelection,
  isEmptyChange,
  parseFlags,
} from "./selection.ts";
import type { SelectionChange } from "./selection.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

const isDelegated = compile(
  obj({ link: opt(nullable(str())), taskId: str() }, { open: true })
).check;

const TITLE_LENGTH = 80;

const USAGE = "Usage: /btw [-mode <name>] [-model <provider/id>] <prompt>";

// delegate_task's target for a Pi child: model as "provider/modelId", and the
// thinking level as an option. A flag that names only one keeps the other.
const targetFor = async (change: SelectionChange) => {
  const current = await currentSelection();
  const options: Record<string, string> = {};

  if (change.thinking !== undefined) {
    options.thinking = change.thinking;
  }

  return { model: change.model ?? current.model, options };
};

// In T3, /btw is a delegate_task child. The child shows up in T3, and its
// result wakes this thread when it finishes.
export const btwCommand = (loadModeSpec: LoadModeSpec): Command => ({
  description:
    "Ask a side question in a T3 child thread: /btw [-mode <name>] [-model <provider/id>] <prompt>",
  handler: async (args, ctx) => {
    try {
      const { flags, text } = parseFlags(args);

      if (text.length === 0) {
        throw new Error(USAGE);
      }

      const change = await changeFromFlags(flags, ctx.cwd, loadModeSpec);
      const parent = ctx.sessionManager.getSessionFile();

      const task = [
        "The user asked this side question while working in another thread. Answer it. Inspect only, change no file.",
        text,
        ...(parent === undefined
          ? []
          : [
              `The other thread's Pi session file is \`${parent}\`. Call session_query on it for any context the question needs.`,
            ]),
      ].join("\n\n");

      const delegate = {
        mode: "async",
        role: "research",
        task,
        title: `btw: ${text}`.slice(0, TITLE_LENGTH),
      };

      const delegated = isEmptyChange(change)
        ? await callT3Tool("delegate_task", delegate)
        : await callT3Tool("delegate_task", {
            ...delegate,
            target: await targetFor(change),
          });

      if (!isDelegated(delegated)) {
        throw new Error("delegate_task returned no task.");
      }

      ctx.ui.notify(
        `btw started: ${delegated.link ?? delegated.taskId}`,
        "info"
      );
    } catch (error) {
      ctx.ui.notify(`btw failed: ${String(error)}`, "error");
    }
  },
});
