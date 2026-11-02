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
// Match the bullet by its label, so a reworded bullet still matches.
const T3_MARKER = "## T3 Code orchestration";

// The section ends at the next h2 heading or closing tag.
const SECTION = /## T3 Code orchestration[\s\S]*?(?=\n## |\n<\/|$)/gu;

const SUBAGENTS_BULLET = /^- Subagents:.*$/gmu;

const SUBAGENTS_LABEL = /^- Subagents:/mu;

const REPLACEMENT =
  "- Subagents: use `delegate_task` for subagent work. Workflow only when asked.";

const trim = (text: string): string =>
  text.replaceAll(SECTION, (section) =>
    section.replaceAll(SUBAGENTS_BULLET, REPLACEMENT)
  );

export const registerBridgeTrim = (pi: ExtensionAPI): void => {
  let warned = false;
  let runOptions: BeforeAgentStartEvent["systemPromptOptions"] | undefined;

  const warnOnDrift = (text: string, ctx: ExtensionContext): void => {
    if (!(text.includes(T3_MARKER) && ctx.hasUI) || warned) {
      return;
    }

    const found = (text.match(SECTION) ?? []).some((section) =>
      SUBAGENTS_LABEL.test(section)
    );

    if (!found) {
      warned = true;
      ctx.ui.notify(
        "pi-t3: T3's orchestration text has no '- Subagents:' bullet, so Pi cannot route subagents through T3. Update src/bridge/bridge-trim.ts.",
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
