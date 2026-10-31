import {
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// T3 shares its orchestration instructions across providers. Pi has neither
// Claude's Agent tool nor Codex's spawn_agent, so route its subagents through T3.
export const BRIDGE_CUTS: readonly string[] = [
  "- Subagents: use your native tool when the child uses your provider, a model it offers, and no settings beyond yours, and it finishes in this turn (Claude `Agent` always with `run_in_background:false`; Codex `spawn_agent`, then wait). Use `delegate_task` for another provider's model, user-asked settings, a separate checkout (`isolation:\"worktree\"`), background work, or `delegate_task` by name. A native type running another provider's model counts too. Workflow only when asked.",
];

const T3_MARKER = "## T3 Code orchestration";

const REPLACEMENT =
  "- Subagents: use `delegate_task` for subagent work. Workflow only when asked.";

const trim = (text: string): string => {
  if (!text.includes(T3_MARKER)) {
    return text;
  }

  let trimmed = text;

  for (const cut of BRIDGE_CUTS) {
    trimmed = trimmed.replaceAll(cut, REPLACEMENT);
  }

  return trimmed;
};

export const registerBridgeTrim = (pi: ExtensionAPI): void => {
  let warned = false;
  let runOptions: BeforeAgentStartEvent["systemPromptOptions"] | undefined;

  const warnOnDrift = (text: string, ctx: ExtensionContext): void => {
    if (!(text.includes(T3_MARKER) && ctx.hasUI) || warned) {
      return;
    }

    const missed = BRIDGE_CUTS.filter(
      (cut) => !(text.includes(cut) || text.includes(REPLACEMENT))
    ).length;

    if (missed > 0) {
      warned = true;
      ctx.ui.notify(
        `pi-t3: ${missed} of ${BRIDGE_CUTS.length} cuts to T3's bridge text no longer match. T3 likely reworded it; update src/bridge/bridge-trim.ts.`,
        "warning"
      );
    }
  };

  pi.on("before_agent_start", (event) => {
    runOptions = event.systemPromptOptions;

    if (runOptions.forceSystemPrompt !== undefined) {
      runOptions.forceSystemPrompt = trim(runOptions.forceSystemPrompt);
    }
  });

  pi.on("context_with_system", (event, ctx) => {
    // Pi projects a forced prompt after this hook, including one set by a
    // later before_agent_start handler such as T3's bridge.
    const forced = runOptions?.forceSystemPrompt;

    const section = getCurrentSystemMessage(event.messages)?.sections
      ?.t3_code_orchestration;

    warnOnDrift(
      forced ?? section ?? getCurrentSystemPrompt(event.messages),
      ctx
    );

    if (runOptions !== undefined && forced !== undefined) {
      runOptions.forceSystemPrompt = trim(forced);
    }

    return {
      messages: event.messages.map((message) => {
        if (message.role !== "system") {
          return message;
        }

        const content = Array.isArray(message.content)
          ? message.content.map((part) => ({
              ...part,
              text: trim(part.text),
            }))
          : trim(message.content);

        const sections =
          message.sections &&
          Object.fromEntries(
            Object.entries(message.sections).map(([key, text]) => [
              key,
              text === null ? null : trim(text),
            ])
          );

        return { ...message, content, sections };
      }),
    };
  });
};
