import type { ExtensionAPI, SourceInfo } from "@earendil-works/pi-coding-agent";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];

// Pi runs the first extension that registered a name, and another package,
// such as pi-ask, registers at load after this extension. So the bridge waits
// for session_start, registers a tool only when no one else has its name, and
// tells the user once that its own tool is off.
export const registerUnlessTaken = (pi: ExtensionAPI, tool: Tool): void => {
  let registered = false;
  let conflict: SourceInfo | undefined;
  let warned = false;

  pi.on("session_start", () => {
    if (registered) {
      return;
    }

    conflict = pi
      .getAllTools()
      .find((other) => other.name === tool.name)?.sourceInfo;

    if (conflict === undefined) {
      pi.registerTool(tool);
      registered = true;
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (
      event.messageType !== "user" ||
      conflict === undefined ||
      warned ||
      !ctx.hasUI
    ) {
      return;
    }

    warned = true;

    const source = conflict.source || conflict.path;

    ctx.ui.notify(
      `pi-t3's ${tool.name} is off because ${source} provides ${tool.name}. Remove ${source} from ~/.pi/agent/settings.json packages to switch.`,
      "warning"
    );
  });
};
