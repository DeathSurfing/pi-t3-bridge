import type { Message } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  defineTool,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { callT3Tool } from "../bridge/t3-http.ts";
import type { LoadModeSpec } from "./package.ts";
import {
  applyChange,
  changeFromFlags,
  currentSelection,
  isEmptyChange,
  parseFlags,
} from "./selection.ts";
import type { Flags } from "./selection.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

const SUMMARY_PROMPT = `You write the first message of a new thread that continues work from a conversation. Given the conversation and the user's goal for the new thread, write a self-contained prompt with:

## Context
The decisions made, approaches taken, and key findings that matter for the goal.

Files involved:
- each relevant file that was discussed or changed

## Task
What the new thread should do next, based on the goal.

Output only the prompt, with no preamble.`;

const TITLE_LENGTH = 80;

const LaunchSchema = Type.Object({
  link: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  threadId: Type.String(),
});

const summarize = async (
  ctx: ExtensionContext,
  goal: string,
  signal: AbortSignal | undefined
): Promise<string> => {
  const { model } = ctx;

  if (model === undefined) {
    throw new Error("No model selected.");
  }

  const messages = ctx.sessionManager
    .getBranch()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));

  if (messages.length === 0) {
    throw new Error("No conversation to hand off.");
  }

  const request: Message = {
    content: [
      {
        text: `## Conversation\n\n${serializeConversation(convertToLlm(messages))}\n\n## Goal for the new thread\n\n${goal}`,
        type: "text",
      },
    ],
    role: "user",
    timestamp: Date.now(),
  };

  const response = await ctx.modelRegistry
    .streamSimple(
      model,
      { messages: [request], systemPrompt: SUMMARY_PROMPT },
      { signal }
    )
    .result();

  if (response.stopReason === "aborted" || response.stopReason === "error") {
    throw new Error(
      response.errorMessage ?? `The summary ${response.stopReason}.`
    );
  }

  return response.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
};

// In T3 a handoff is a new T3 thread. Pi keeps its own session file, which is
// the one T3 resumes this thread from.
const handoff = async (
  ctx: ExtensionContext,
  goal: string,
  flags: Flags,
  loadModeSpec: LoadModeSpec,
  signal: AbortSignal | undefined
): Promise<string> => {
  const change = await changeFromFlags(flags, ctx.cwd, loadModeSpec);
  const summary = await summarize(ctx, goal, signal);
  const parent = ctx.sessionManager.getSessionFile();

  const message = [
    goal,
    ...(parent === undefined
      ? []
      : ["/skill:session-query", `**Parent session:** \`${parent}\``]),
    summary,
  ].join("\n\n");

  const launch = { message, title: goal.slice(0, TITLE_LENGTH) };

  const launched = isEmptyChange(change)
    ? await callT3Tool("t3_thread_launch", launch)
    : await callT3Tool("t3_thread_launch", {
        ...launch,
        modelSelection: { ...applyChange(await currentSelection(), change) },
      });

  if (!Value.Check(LaunchSchema, launched)) {
    throw new Error("t3_thread_launch returned no thread.");
  }

  return launched.link ?? launched.threadId;
};

export const handoffTool = (loadModeSpec: LoadModeSpec) =>
  defineTool({
    description:
      "Transfer context to a new focused T3 thread. ONLY use this when the user explicitly asks for a handoff. Provide a goal describing what the new thread should focus on. The result is the new thread's link, which you show the user verbatim.",
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const link = await handoff(
        ctx,
        params.goal,
        { mode: params.mode, model: params.model },
        loadModeSpec,
        signal
      );

      return {
        content: [{ text: `Handoff thread started: ${link}`, type: "text" }],
        details: { link },
      };
    },
    label: "Handoff",
    name: "handoff",
    parameters: Type.Object({
      goal: Type.String({ description: "The goal/task for the new thread" }),
      mode: Type.Optional(
        Type.String({
          description:
            "Amplike mode name to start the new thread with (e.g. 'rush', 'smart', 'deep')",
        })
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model to start the new thread with, as provider/modelId (e.g. 'anthropic/claude-haiku-4-5')",
        })
      ),
    }),
  });

export const handoffCommand = (loadModeSpec: LoadModeSpec): Command => ({
  description:
    "Start a new T3 thread with a summary of this one: /handoff [-mode <name>] [-model <provider/id>] <goal>",
  handler: async (args, ctx) => {
    try {
      const { flags, text } = parseFlags(args);

      if (text.length === 0) {
        throw new Error(
          "Usage: /handoff [-mode <name>] [-model <provider/id>] <goal>"
        );
      }

      const link = await handoff(ctx, text, flags, loadModeSpec, ctx.signal);

      ctx.ui.notify(`Handoff thread started: ${link}`, "info");
    } catch (error) {
      ctx.ui.notify(`Handoff failed: ${String(error)}`, "error");
    }
  },
});
