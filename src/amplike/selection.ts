import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { callT3Tool } from "../bridge/t3-http.ts";
import type { LoadModeSpec } from "./package.ts";

const OptionSchema = Type.Object({
  id: Type.String(),
  value: Type.Union([Type.String(), Type.Boolean()]),
});

const SelectionSchema = Type.Object({
  instanceId: Type.Optional(Type.String()),
  model: Type.String(),
  options: Type.Optional(Type.Array(OptionSchema)),
});

const ConfigureSchema = Type.Object({ modelSelection: SelectionSchema });

// T3's modelSelection for a Pi thread: model is "provider/modelId", and the
// thinking level is the "thinking" option.
export type Selection = Static<typeof SelectionSchema>;

export interface SelectionChange {
  model?: string;
  thinking?: string;
}

export interface Flags {
  mode?: string;
  model?: string;
}

export interface ParsedArgs {
  readonly flags: Flags;
  readonly text: string;
}

const THINKING = "thinking";

export const isEmptyChange = (change: SelectionChange): boolean =>
  change.model === undefined && change.thinking === undefined;

export const currentSelection = async (): Promise<Selection> => {
  const result = await callT3Tool("t3_thread_configure", {});

  if (!Value.Check(ConfigureSchema, result)) {
    throw new Error("t3_thread_configure returned no modelSelection.");
  }

  return result.modelSelection;
};

export const applyChange = (
  current: Selection,
  change: SelectionChange
): Selection => {
  const next: Selection = { ...current, model: change.model ?? current.model };

  if (change.thinking !== undefined) {
    next.options = [
      ...(current.options ?? []).filter((option) => option.id !== THINKING),
      { id: THINKING, value: change.thinking },
    ];
  }

  return next;
};

export const configureThread = async (selection: Selection): Promise<void> => {
  await callT3Tool("t3_thread_configure", { modelSelection: { ...selection } });
};

// amplike's commands take `-mode <name>` and `-model <provider/id>` before the
// text, in either order.
export const parseFlags = (args: string): ParsedArgs => {
  const words = args.trim().split(/\s+/u);
  const flags: Flags = {};

  while (words[0] === "-mode" || words[0] === "-model") {
    const [flag, value] = words.splice(0, 2);

    if (value === undefined) {
      throw new Error(`${flag} needs a value.`);
    }

    if (flag === "-mode") {
      flags.mode = value;
    } else {
      flags.model = value;
    }
  }

  return { flags, text: words.join(" ") };
};

// Same order as amplike: the mode sets model and thinking, then -model
// overrides the model.
export const changeFromFlags = async (
  flags: Flags,
  cwd: string,
  loadModeSpec: LoadModeSpec
): Promise<SelectionChange> => {
  const change: SelectionChange = {};

  if (flags.mode !== undefined) {
    const spec = await loadModeSpec(cwd, flags.mode);

    if (spec === undefined) {
      throw new Error(`Unknown mode "${flags.mode}".`);
    }

    if (spec.provider !== undefined && spec.modelId !== undefined) {
      change.model = `${spec.provider}/${spec.modelId}`;
    }

    change.thinking = spec.thinkingLevel;
  }

  if (flags.model !== undefined) {
    if (!flags.model.includes("/")) {
      throw new Error(
        `Model "${flags.model}" must be written as provider/modelId.`
      );
    }

    change.model = flags.model;
  }

  return change;
};
