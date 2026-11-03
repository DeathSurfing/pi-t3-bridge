import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  Api,
  ClassifierBoolQuestion,
  ClassifierContext,
  ClassifierQuestion,
  JsonObject,
  Model,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import { readConfig } from "./config.ts";
import type { MastExcerpt, StopInput } from "./steer-transcript.ts";

// Asks TypeSafe's Jev how a run ended, or a chat model when Jev is not
// available. The classifier call follows pi-mast-steer's src/judge.ts (MIT,
// github.com/dbreunig/pi-mast-steer): any failure becomes an error value, so a
// judge that is down never blocks a session.

const StopKindSchema = Type.Union([
  Type.Literal("done"),
  Type.Literal("blocked"),
  Type.Literal("asked_permission"),
  Type.Literal("gave_up_midway"),
]);

export type StopKind = Static<typeof StopKindSchema>;

export type StopVerdict =
  | {
      readonly kind: StopKind;
      readonly unfinished: number;
      readonly handoffMissing: number | undefined;
    }
  | { readonly error: string };

const BoolQuestionSchema = Type.Object({
  criteria: Type.Object({ false: Type.String(), true: Type.String() }),
  instructions: Type.String(),
  type: Type.Literal("bool"),
});

const QuestionsFileSchema = Type.Object({
  instructions: Type.String(),
  questions: Type.Object({
    handoff_missing: BoolQuestionSchema,
    stop_kind: Type.Object({
      criteria: Type.Record(Type.String(), Type.String()),
      instructions: Type.String(),
      type: Type.Literal("choice"),
    }),
    unfinished: BoolQuestionSchema,
  }),
  thresholds: Type.Object({
    handoff: Type.Number(),
    unfinished: Type.Number(),
  }),
});

const BoolAnswerSchema = Type.Object({
  probability: Type.Number(),
  type: Type.Literal("bool"),
});

const AnswersSchema = Type.Object({
  handoff_missing: Type.Optional(BoolAnswerSchema),
  stop_kind: Type.Object({
    choice: StopKindSchema,
    type: Type.Literal("choice"),
  }),
  unfinished: BoolAnswerSchema,
});

const readQuestions = (): Static<typeof QuestionsFileSchema> => {
  const questions: unknown = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "steer-questions.json"),
      "utf-8"
    )
  );

  if (!Value.Check(QuestionsFileSchema, questions)) {
    throw new TypeError(
      "steer-questions.json does not have the expected shape."
    );
  }

  return questions;
};

// Fitted on the user's own labelled stops. See the stop-steer outline, phase 6.
export const stopThresholds = () => readQuestions().thresholds;

type Asked = { readonly answers: unknown } | { readonly error: string };

const ANSWER_TOOL = "classifier_answers";

// One flat argument per asked question: a bool is a probability, a choice is
// one of its criteria keys. No caller asks a score question.
const answerSchema = (question: ClassifierQuestion): TSchema => {
  switch (question.type) {
    case "bool": {
      return Type.Number({ maximum: 1, minimum: 0 });
    }

    case "choice": {
      return Type.Union(
        Object.keys(question.criteria).map((key) => Type.Literal(key))
      );
    }

    default: {
      return Type.Never();
    }
  }
};

const chatPrompt = (context: ClassifierContext): string =>
  [
    "Judge the state below by answering each question.",
    `Call ${ANSWER_TOOL} exactly once, with one value for every question.`,
    'For a bool question, give the probability from 0 to 1 that its "true" criteria holds.',
    "For a choice question, give the key of the criteria that fits best.",
    "",
    "Questions, as JSON:",
    JSON.stringify(context.questions),
    "",
    "State, as JSON:",
    JSON.stringify(context.state),
  ].join("\n");

type FlatAnswer =
  | { readonly probability: number; readonly type: "bool" }
  | { readonly choice: string; readonly type: "choice" };

// Parses one flat value per question, checked against that question's own
// schema, and turns it into the answer shape a classifier returns.
const parseAnswers = <S extends TSchema>(
  schema: S,
  questions: ClassifierContext["questions"],
  candidate: Static<S>
): Record<string, FlatAnswer> | undefined => {
  if (!Value.Check(schema, candidate)) {
    return undefined;
  }

  if (Object.keys(candidate).length !== Object.keys(questions).length) {
    return undefined;
  }

  const answers: Record<string, FlatAnswer> = {};

  for (const [name, question] of Object.entries(questions)) {
    const value = candidate[name];

    switch (question.type) {
      case "bool": {
        if (!Value.Check(Type.Number({ maximum: 1, minimum: 0 }), value)) {
          return undefined;
        }

        answers[name] = { probability: value, type: "bool" };
        break;
      }

      case "choice": {
        if (
          !Value.Check(Type.String(), value) ||
          !Value.Check(answerSchema(question), value)
        ) {
          return undefined;
        }

        answers[name] = { choice: value, type: "choice" };
        break;
      }

      default: {
        return undefined;
      }
    }
  }

  return answers;
};

const askChat = async (
  ctx: ExtensionContext,
  model: Model<Api>,
  context: ClassifierContext,
  signal: AbortSignal
): Promise<Asked> => {
  const schema = Type.Object(
    Object.fromEntries(
      Object.entries(context.questions).map(([name, question]) => [
        name,
        answerSchema(question),
      ])
    ),
    { additionalProperties: false }
  );

  try {
    const reply = await ctx.modelRegistry
      .streamSimple(
        model,
        {
          messages: [
            {
              content: chatPrompt(context),
              role: "user",
              timestamp: Date.now(),
            },
          ],
          tools: [
            {
              constrainedSampling: { strict: "prefer", type: "json_schema" },
              description: "Record your answer to every question.",
              name: ANSWER_TOOL,
              parameters: schema,
            },
          ],
        },
        { signal }
      )
      .result();

    if (reply.stopReason !== "stop" && reply.stopReason !== "toolUse") {
      return { error: reply.errorMessage ?? reply.stopReason };
    }

    const call = reply.content.find(
      (part) => part.type === "toolCall" && part.name === ANSWER_TOOL
    );

    const answers =
      call?.type === "toolCall"
        ? parseAnswers(schema, context.questions, call.arguments)
        : undefined;

    if (answers === undefined) {
      return {
        error: `${model.provider}/${model.id} did not answer through ${ANSWER_TOOL}`,
      };
    }

    return { answers };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

// The judge is classifierModel when set, else Jev when it is available, else
// the session model. Failures are values. Nothing here throws on a judge that
// is down.
const askClassifier = async (
  ctx: ExtensionContext,
  context: ClassifierContext,
  signal: AbortSignal
): Promise<Asked> => {
  const { classifierModel } = readConfig();

  if (classifierModel !== undefined) {
    const slash = classifierModel.indexOf("/");

    const chosen = ctx.modelRegistry.find(
      classifierModel.slice(0, slash),
      classifierModel.slice(slash + 1)
    );

    if (chosen === undefined) {
      return {
        error: `classifierModel "${classifierModel}" is not in the model catalog`,
      };
    }

    if (!ctx.modelRegistry.hasConfiguredAuth(chosen)) {
      return {
        error: `classifierModel "${classifierModel}" has no configured auth`,
      };
    }

    return askChat(ctx, chosen, context, signal);
  }

  const jev = ctx.modelRegistry.findOfType(
    "classifier",
    "typesafe",
    "jev-latest"
  );

  let available: Awaited<
    ReturnType<typeof ctx.modelRegistry.getAvailableOfType>
  >;

  try {
    available = await ctx.modelRegistry.getAvailableOfType(
      "classifier",
      "typesafe",
      { signal }
    );
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (
    jev !== undefined &&
    available.some(
      (model) => model.provider === jev.provider && model.id === jev.id
    )
  ) {
    const result = await ctx.modelRegistry.classify(jev, context, { signal });

    return result.stopReason === "stop"
      ? { answers: result.answers }
      : { error: result.errorMessage ?? result.stopReason };
  }

  if (ctx.model !== undefined) {
    return askChat(ctx, ctx.model, context, signal);
  }

  return {
    error:
      "typesafe/jev-latest is not available and the session has no model to judge with",
  };
};

export const judgeStop = async (
  ctx: ExtensionContext,
  input: StopInput,
  signal: AbortSignal
): Promise<StopVerdict> => {
  const { instructions, questions } = readQuestions();

  // Without the user's rule there is nothing to measure the ending against,
  // so the handoff question is not asked. The caller leaves the rule out for a
  // delegated child, which reports to its parent, not to the user.
  const rules = input.userRules;

  const state: JsonObject = {
    final_message: input.finalMessage,
    instructions,
    recent_work: input.recentWork,
    task: input.task,
  };

  const asked: ClassifierContext["questions"] = {
    stop_kind: questions.stop_kind,
    unfinished: questions.unfinished,
  };

  if (rules !== undefined) {
    state.user_rules = rules;
    asked.handoff_missing = questions.handoff_missing;
  }

  const result = await askClassifier(ctx, { questions: asked, state }, signal);

  if ("error" in result) {
    return result;
  }

  const { answers } = result;

  if (!Value.Check(AnswersSchema, answers)) {
    return { error: "the classifier did not answer the stop questions" };
  }

  if (rules !== undefined && answers.handoff_missing === undefined) {
    return { error: "the classifier did not answer handoff_missing" };
  }

  return {
    handoffMissing: answers.handoff_missing?.probability,
    kind: answers.stop_kind.choice,
    unfinished: answers.unfinished.probability,
  };
};

// The five MAST questions, ported from pi-mast-steer
// (MIT, github.com/dbreunig/pi-mast-steer, fixtures/dspy-request.json and
// src/modes.ts). The questions and criteria are copied as they are, because
// the thresholds were calibrated on them.
const MastModeSchema = Type.Object({
  code: Type.String(),
  field: Type.String(),
  label: Type.String(),
  note: Type.String(),
  threshold: Type.Number(),
});

export type MastMode = Static<typeof MastModeSchema>;

const MastFileSchema = Type.Object({
  every: Type.Integer({ minimum: 1 }),
  input_fields: Type.String(),
  instructions: Type.String(),
  modes: Type.Array(MastModeSchema),
  questions: Type.Record(
    Type.String(),
    Type.Object({
      // The DSPy criteria are nested objects, which TypeSafe accepts. The
      // classifier types only describe the plain-text form.
      criteria: Type.Unsafe<ClassifierBoolQuestion["criteria"]>(
        Type.Object({}, { additionalProperties: true })
      ),
      instructions: Type.String(),
    })
  ),
});

const readMast = (): Static<typeof MastFileSchema> => {
  const mast: unknown = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "steer-mast.json"), "utf-8")
  );

  if (
    !Value.Check(MastFileSchema, mast) ||
    mast.modes.some((mode) => mast.questions[mode.field] === undefined)
  ) {
    throw new TypeError("steer-mast.json does not have the expected shape.");
  }

  return mast;
};

export const mastModes = (): readonly MastMode[] => readMast().modes;

// Completed turns between MAST checks.
export const mastEvery = (): number => readMast().every;

export type MastVerdict =
  | { readonly probabilities: Readonly<Record<string, number>> }
  | { readonly error: string };

export const judgeMast = async (
  ctx: ExtensionContext,
  excerpt: MastExcerpt,
  signal: AbortSignal
): Promise<MastVerdict> => {
  const mast = readMast();

  const result = await askClassifier(
    ctx,
    {
      // Pi sends `bool` questions to TypeSafe as `noul`, the type DSPy sends.
      questions: Object.fromEntries(
        mast.modes.map((mode) => [
          mode.field,
          { ...mast.questions[mode.field], type: "bool" as const },
        ])
      ),
      state: {
        input_fields: mast.input_fields,
        inputs: {
          task: excerpt.task,
          trace_window: excerpt.window,
          window_position: excerpt.position,
        },
        instructions: mast.instructions,
      },
    },
    signal
  );

  if ("error" in result) {
    return result;
  }

  const { answers } = result;

  if (!Value.Check(Type.Record(Type.String(), Type.Unknown()), answers)) {
    return { error: "the classifier did not answer the MAST questions" };
  }

  const probabilities: Record<string, number> = {};

  for (const mode of mast.modes) {
    const answer = answers[mode.field];

    if (!Value.Check(BoolAnswerSchema, answer)) {
      return { error: `no answer for ${mode.code}` };
    }

    probabilities[mode.code] = answer.probability;
  }

  return { probabilities };
};
