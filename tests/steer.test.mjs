import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import * as piAi from "@earendil-works/pi-ai";

import { newWorld, startSession } from "./harness.mjs";

const temporary = await mkdtemp(path.join(tmpdir(), "pi-t3-bridge-steer-"));

const savedEnv = new Map(
  [
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "T3_MCP_URL",
    "T3_MCP_BEARER_TOKEN",
  ].map((key) => [key, process.env[key]])
);

// Tests run inside a T3 thread would otherwise ask the real T3 which thread
// they are. A test that needs T3 starts its own stand-in.
Reflect.deleteProperty(process.env, "T3_MCP_URL");

Reflect.deleteProperty(process.env, "T3_MCP_BEARER_TOKEN");

after(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }

  await rm(temporary, { force: true, recursive: true });
});

let count = 0;

// A bridge config and a state directory of the test's own. `config` is what
// the user would have written in ~/.config/pi-t3/config.json.
const arrange = async (config) => {
  count += 1;

  const configDir = path.join(temporary, `config-${count}`, "pi-t3");

  process.env.XDG_CONFIG_HOME = path.join(temporary, `config-${count}`);
  process.env.XDG_STATE_HOME = path.join(temporary, `state-${count}`);
  await mkdir(configDir, { recursive: true });

  if (config !== undefined) {
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify(config)
    );
  }

  const logPath = path.join(process.env.XDG_STATE_HOME, "pi-t3", "steer.jsonl");

  return {
    log: async () => {
      const text = await readFile(logPath, "utf-8").catch(() => "");

      return text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));
    },
    logText: () => readFile(logPath, "utf-8"),
  };
};

// What Jev answers for one ending. Like Jev, it answers only what was asked.
const answers = (context, { handoffMissing = 0.05, kind, unfinished }) => {
  const given = {
    stop_kind: {
      choice: kind,
      confidence: 0.95,
      probabilities: { [kind]: 0.95 },
      type: "choice",
    },
    unfinished: { probability: unfinished, type: "bool" },
  };

  if (context.questions.handoff_missing !== undefined) {
    given.handoff_missing = { probability: handoffMissing, type: "bool" };
  }

  return given;
};

// The five MAST questions are asked by field name. Jev answers each with a
// probability, which a test sets by MAST code.
const MAST_FIELDS = {
  1.1: "disobey_task_spec",
  1.3: "step_repetition",
  1.5: "unaware_of_termination",
  2.3: "task_derailment",
  2.6: "reasoning_action_mismatch",
};

const mastAnswers = (scores) =>
  Object.fromEntries(
    Object.entries(MAST_FIELDS).map(([code, field]) => [
      field,
      { probability: scores[code] ?? 0, type: "bool" },
    ])
  );

// A classifier that gives the next stop verdict on each stop call, and the
// last one after that. MAST calls are told apart by their questions and get
// the next scores in `mast`, by MAST code. A MAST call with no scores left
// gets the last ones, and none at first means every probability is zero.
// `requests` records what the session sent for stops, `mastRequests` for MAST.
const scriptedWith = (verdicts, mast = [{}]) => {
  const requests = [];
  const mastRequests = [];

  return {
    classify: (context) => {
      if (context.questions.stop_kind === undefined) {
        mastRequests.push(context);

        return {
          answers: mastAnswers(
            mast[Math.min(mastRequests.length, mast.length) - 1]
          ),
          stopReason: "stop",
        };
      }

      requests.push(context);

      const verdict = verdicts[Math.min(requests.length, verdicts.length) - 1];

      return verdict.error === undefined
        ? { answers: answers(context, verdict), stopReason: "stop" }
        : { answers: {}, errorMessage: verdict.error, stopReason: "error" };
    },
    mastRequests,
    requests,
  };
};

const scripted = (...verdicts) => scriptedWith(verdicts);

const GAVE_UP = { kind: "gave_up_midway", unfinished: 0.92 };
const DONE = { kind: "done", unfinished: 0.05 };

const quits = (text) => piAi.fauxAssistantMessage(text);

const branchOf = (session) => session.sessionManager.getBranch();

const notesIn = (session) =>
  branchOf(session).filter(
    (entry) =>
      entry.type === "custom_message" && entry.customType === "pi-t3-steer"
  );

const assistantTexts = (session) =>
  branchOf(session).flatMap((entry) =>
    entry.type === "message" && entry.message.role === "assistant"
      ? [
          entry.message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join(""),
        ]
      : []
  );

const start = (name, classify, extra = {}) =>
  startSession({ classify, name, root: temporary, ...extra });

const rulesFile = {
  content: [
    "# Global Instructions",
    "- Be brief.",
    "",
    "# What you need from me",
    "- End every turn that needs me with a numbered 'What I need from you' section.",
    "",
    "## Decisions",
    "- Walk through two-way doors.",
  ].join("\n"),
  path: "/home/user/.pi/agent/AGENTS.md",
};

test("shadow mode judges how a run ended and leaves the session alone", async () => {
  const { log, logText } = await arrange({ steer: "shadow" });
  const jev = scripted(GAVE_UP);
  const { session, turn } = await start("shadow", jev.classify);

  const final = "Next I'll patch src/retry.ts and run the tests.";

  try {
    await turn([[["bash", { command: "ls" }]]], "Fix the retry bug.", final);

    assert.deepEqual(assistantTexts(session).at(-1), final);
    assert.equal(assistantTexts(session).length, 2);
    assert.deepEqual(notesIn(session), []);

    assert.equal(jev.requests.length, 1);
    assert.equal(jev.requests[0].state.task, "Fix the retry bug.");
    assert.equal(jev.requests[0].state.final_message, final);
    assert.match(jev.requests[0].state.recent_work, /tool call: bash/u);

    const [line, ...rest] = await log();

    assert.deepEqual(rest, []);
    assert.equal(line.kind, "stop");
    assert.equal(line.mode, "shadow");
    assert.equal(line.model, "claude-opus-5-5");
    assert.equal(line.nudged, false);
    assert.equal(line.session, session.sessionManager.getSessionId());
    assert.deepEqual(line.verdict, {
      kind: "gave_up_midway",
      unfinished: 0.92,
    });
    assert.ok(!Number.isNaN(Date.parse(line.time)));

    const raw = await logText();

    assert.ok(!raw.includes("retry"), "the log holds no transcript text");
  } finally {
    session.dispose();
  }
});

test("a config without a steer key steers", async () => {
  const { log } = await arrange({});
  const jev = scripted(GAVE_UP, DONE);
  const { faux, session } = await start("default-on", jev.classify);

  try {
    faux.setResponses([
      quits("Next I'll patch src/retry.ts and run the tests."),
      quits("Patched, and the tests pass."),
    ]);
    await session.prompt("Fix the retry bug.");

    assert.equal(notesIn(session).length, 1);

    const lines = await log();

    assert.deepEqual(
      lines.map((line) => [line.mode, line.nudged]),
      [
        ["on", true],
        ["on", false],
      ]
    );
  } finally {
    session.dispose();
  }
});

test("a classifier that fails changes nothing and the failure is logged", async () => {
  const { log } = await arrange({ steer: "on" });
  const jev = scripted({ error: "Provider is not configured: typesafe" });
  const { session, turn } = await start("failing", jev.classify);

  try {
    await turn([], "Fix the retry bug.", "Next I'll patch src/retry.ts.");

    assert.equal(assistantTexts(session).length, 1);
    assert.deepEqual(notesIn(session), []);

    const [line, ...rest] = await log();

    assert.deepEqual(rest, []);
    assert.equal(line.kind, "stop");
    assert.equal(line.error, "Provider is not configured: typesafe");
    assert.equal(line.nudged, false);
    assert.equal(line.verdict, undefined);
  } finally {
    session.dispose();
  }
});

test("steer off never calls the classifier", async () => {
  const { log } = await arrange({ steer: "off" });
  const jev = scripted(GAVE_UP);
  const { session, turn } = await start("off", jev.classify);

  try {
    await turn([], "Fix the retry bug.", "Next I'll patch src/retry.ts.");

    assert.equal(jev.requests.length, 0);
    assert.equal(assistantTexts(session).length, 1);
    assert.deepEqual(await log(), []);
  } finally {
    session.dispose();
  }
});

test("the judge gets the user's handoff rule only when a context file has one", async () => {
  const { log } = await arrange({ steer: "shadow" });
  const jev = scripted({ ...DONE, handoffMissing: 0.88 });

  const ruled = await start("rule", jev.classify, {
    agentsFiles: [rulesFile],
  });

  try {
    await ruled.turn([], "Update the README.", "All done. Tests pass.");

    const [request] = jev.requests;

    assert.match(request.state.user_rules, /What I need from you/u);
    assert.match(request.state.user_rules, /^# What you need from me/u);
    assert.doesNotMatch(request.state.user_rules, /Be brief|two-way doors/u);
    assert.ok(request.questions.handoff_missing);

    const [line] = await log();

    assert.deepEqual(line.verdict, {
      handoffMissing: 0.88,
      kind: "done",
      unfinished: 0.05,
    });
  } finally {
    ruled.session.dispose();
  }

  const bare = await start("no-rule", jev.classify);

  try {
    await bare.turn([], "Update the README.", "All done. Tests pass.");

    const request = jev.requests.at(-1);

    assert.equal(jev.requests.length, 2);
    assert.equal(request.state.user_rules, undefined);
    assert.equal(request.questions.handoff_missing, undefined);

    const lines = await log();

    assert.equal(lines.at(-1).verdict.handoffMissing, undefined);
  } finally {
    bare.session.dispose();
  }
});

test("an early stop gets a keep-going note and then continues", async () => {
  const { log } = await arrange({ steer: "on" });
  const jev = scripted(GAVE_UP, DONE);
  const { faux, session } = await start("early", jev.classify);

  try {
    faux.setResponses([
      quits("Next I'll patch src/retry.ts and run the tests."),
      quits("Patched, and the tests pass."),
    ]);
    await session.prompt("Fix the retry bug.");

    const conversation = branchOf(session)
      .filter(
        (entry) =>
          entry.type === "custom_message" ||
          (entry.type === "message" && entry.message.role !== "system")
      )
      .map((entry) =>
        entry.type === "message" ? entry.message.role : entry.type
      );

    assert.deepEqual(conversation, [
      "user",
      "assistant",
      "custom_message",
      "assistant",
    ]);

    const [note] = notesIn(session);

    assert.equal(note.display, true);
    assert.match(note.content, /^Steer · Stopped early \(p=0\.92\):/u);
    assert.equal(
      assistantTexts(session).at(-1),
      "Patched, and the tests pass."
    );

    const lines = await log();

    assert.deepEqual(
      lines.map((line) => [line.verdict.kind, line.nudged]),
      [
        ["gave_up_midway", true],
        ["done", false],
      ]
    );
  } finally {
    session.dispose();
  }
});

test("an orchestrator that ends its turn while a delegated child runs is not told to keep going", async () => {
  const { log } = await arrange({ steer: "on" });
  const jev = scripted({ ...GAVE_UP, handoffMissing: 0.05 });
  const world = newWorld();

  const { faux, session } = await start("waiting", jev.classify, {
    agentsFiles: [rulesFile],
    world,
  });

  try {
    faux.setResponses([
      piAi.fauxAssistantMessage(
        [
          piAi.fauxToolCall("mcp__t3-code__delegate_task", {
            mode: "async",
            task: "Research how the retry loop resets its counter.",
          }),
        ],
        { stopReason: "toolUse" }
      ),
      quits(
        "The research is running. I'll write the fix when it finishes.\n\n**What I need from you**\nNothing needed from you right now."
      ),
    ]);
    await session.prompt("Fix the retry bug.");

    assert.equal(world.delegated.length, 1);
    assert.deepEqual(notesIn(session), []);

    const lines = await log();

    assert.deepEqual(
      lines.map((line) => [line.verdict.kind, line.nudged]),
      [["gave_up_midway", false]]
    );
  } finally {
    session.dispose();
  }
});

test("a wake-up from one child while another still runs gets no keep-going note, and the last wake-up does", async () => {
  await arrange({ steer: "on" });
  // The two waiting stops and the stop after the last wake-up quit early.
  const jev = scripted(GAVE_UP, GAVE_UP, GAVE_UP, DONE);
  const world = newWorld();

  const { faux, session } = await start("two-children", jev.classify, {
    world,
  });

  const waiting = quits(
    "Waiting for the other child.\n\n**What I need from you**\nNothing needed from you right now."
  );

  try {
    faux.setResponses([
      piAi.fauxAssistantMessage(
        [
          piAi.fauxToolCall("mcp__t3-code__delegate_task", {
            mode: "async",
            task: "Research A.",
          }),
          piAi.fauxToolCall("mcp__t3-code__delegate_task", {
            mode: "async",
            task: "Research B.",
          }),
        ],
        { stopReason: "toolUse" }
      ),
      waiting,
      waiting,
      quits("Next I'll write the fix."),
      quits("Fixed."),
    ]);
    await session.prompt("Fix the retry bug.");
    await session.prompt(
      "Delegated task task-1 (Research A) [completed]: A is done."
    );

    assert.equal(world.delegated.length, 2);
    assert.deepEqual(notesIn(session), []);

    await session.prompt(
      "Delegated task task-2 (Research B) [completed]: B is done."
    );

    const [note, ...rest] = notesIn(session);

    assert.deepEqual(rest, []);
    assert.equal(note.details.kind, "early");
    assert.equal(assistantTexts(session).at(-1), "Fixed.");
  } finally {
    session.dispose();
  }
});

test("a child whose turn finished while its own children still run counts as running", async () => {
  await arrange({ steer: "on" });
  const jev = scripted(GAVE_UP);
  const world = newWorld();

  world.taskStatus = {
    hasPendingChildRuns: true,
    status: "completed",
    taskId: "task-1",
    workState: "waiting_for_children",
  };

  const { faux, session } = await start("grandchildren", jev.classify, {
    world,
  });

  try {
    faux.setResponses([
      piAi.fauxAssistantMessage(
        [
          piAi.fauxToolCall("mcp__t3-code__delegate_task", {
            mode: "async",
            task: "Research A.",
          }),
        ],
        { stopReason: "toolUse" }
      ),
      piAi.fauxAssistantMessage(
        [piAi.fauxToolCall("mcp__t3-code__task_status", { taskId: "task-1" })],
        { stopReason: "toolUse" }
      ),
      quits("The child is still waiting on its own children."),
    ]);
    await session.prompt("Fix the retry bug.");

    assert.deepEqual(notesIn(session), []);
  } finally {
    session.dispose();
  }
});

test("a model that asks permission for work it can do itself is nudged too", async () => {
  await arrange({ steer: "on" });
  const jev = scripted({ kind: "asked_permission", unfinished: 0.88 }, DONE);
  const { faux, session } = await start("permission", jev.classify);

  try {
    faux.setResponses([
      quits("Do you want me to apply it to the remaining 14 files?"),
      quits("Applied to all 14 files."),
    ]);
    await session.prompt("Migrate the files.");

    assert.equal(notesIn(session).length, 1);
    assert.equal(assistantTexts(session).at(-1), "Applied to all 14 files.");
  } finally {
    session.dispose();
  }
});

test("a done verdict, a blocked verdict, and a weak early-stop verdict get no nudge", async () => {
  const { log } = await arrange({ steer: "on" });

  const jev = scripted(
    DONE,
    { kind: "blocked", unfinished: 0.9 },
    { kind: "gave_up_midway", unfinished: 0.1 }
  );

  const { faux, session } = await start("quiet", jev.classify);

  try {
    const say = async (text) => {
      faux.setResponses([quits(text)]);
      await session.prompt(text);
    };

    await say("All done.");
    await say("Need the token.");
    await say("Maybe more later.");

    assert.equal(jev.requests.length, 3);
    assert.deepEqual(notesIn(session), []);
    assert.equal(assistantTexts(session).length, 3);
    const lines = await log();

    assert.deepEqual(
      lines.map((line) => line.nudged),
      [false, false, false]
    );
  } finally {
    session.dispose();
  }
});

test("one prompt gets one stop nudge, a held-back one is logged as capped, and a new prompt starts the count again", async () => {
  const { log } = await arrange({ steer: "on" });
  const jev = scripted(GAVE_UP);
  const { faux, session } = await start("cap", jev.classify);

  try {
    faux.setResponses([
      quits("Next I'll patch a.ts."),
      quits("Next I'll patch b.ts."),
    ]);
    await session.prompt("Patch everything.");

    assert.equal(notesIn(session).length, 1);
    assert.equal(assistantTexts(session).length, 2);
    assert.equal(assistantTexts(session).at(-1), "Next I'll patch b.ts.");
    assert.equal(jev.requests.length, 2, "the capped stop is judged");
    const lines = await log();

    assert.deepEqual(
      lines.map(({ capped, nudged }) => ({ capped, nudged })),
      [
        { capped: false, nudged: true },
        { capped: true, nudged: false },
      ]
    );

    faux.setResponses([
      quits("Next I'll patch c.ts."),
      quits("Next I'll patch d.ts."),
    ]);
    await session.prompt("And the rest.");

    assert.equal(notesIn(session).length, 2);
    assert.equal(assistantTexts(session).length, 4);
  } finally {
    session.dispose();
  }
});

test("a reply cut off at the output limit is told to continue, with no classifier call for it", async () => {
  const { log } = await arrange({ steer: "on" });
  const jev = scripted(DONE);
  const { faux, session } = await start("length", jev.classify);

  try {
    faux.setResponses([
      piAi.fauxAssistantMessage("Here is the plan, step one is to", {
        stopReason: "length",
      }),
      quits("Step one is to read the file. That is the plan."),
    ]);
    await session.prompt("Write the plan.");

    const [note] = notesIn(session);

    assert.match(note.content, /^Steer · Cut off:/u);
    assert.equal(notesIn(session).length, 1);
    assert.equal(jev.requests.length, 1);
    assert.match(jev.requests[0].state.final_message, /That is the plan\.$/u);

    const lines = await log();

    assert.deepEqual(
      lines.map((line) => [line.kind, line.nudged]),
      [
        ["length", true],
        ["stop", false],
      ]
    );
  } finally {
    session.dispose();
  }
});

test("shadow mode does not continue a cut-off reply either", async () => {
  const { log } = await arrange({ steer: "shadow" });
  const jev = scripted(DONE);
  const { faux, session } = await start("length-shadow", jev.classify);

  try {
    faux.setResponses([
      piAi.fauxAssistantMessage("Here is the plan, step one is to", {
        stopReason: "length",
      }),
    ]);
    await session.prompt("Write the plan.");

    assert.deepEqual(notesIn(session), []);
    assert.equal(assistantTexts(session).length, 1);
    const lines = await log();

    assert.deepEqual(
      lines.map((line) => [line.kind, line.nudged]),
      [["length", false]]
    );
  } finally {
    session.dispose();
  }
});

test("a run the user aborts gets no nudge and no classifier call", async () => {
  const { log } = await arrange({ steer: "on" });
  const jev = scripted(GAVE_UP);
  const { faux, session } = await start("abort", jev.classify);

  try {
    const { promise: toolRunning, resolve } = Promise.withResolvers();

    session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        resolve(event);
      }
    });

    faux.setResponses([
      piAi.fauxAssistantMessage(
        [piAi.fauxToolCall("bash", { command: "sleep 30" })],
        { stopReason: "toolUse" }
      ),
      quits("Next I'll patch src/retry.ts."),
    ]);

    const run = session.prompt("Fix the retry bug.");

    await toolRunning;
    await session.abort();
    await run;

    const last = session.messages.findLast(
      (message) => message.role === "assistant"
    );

    assert.notEqual(last.stopReason, "stop");
    assert.ok(
      !assistantTexts(session).includes("Next I'll patch src/retry.ts."),
      "the run did not go on to the scripted ending"
    );
    assert.equal(jev.requests.length, 0);
    assert.deepEqual(notesIn(session), []);
    assert.deepEqual(await log(), []);
  } finally {
    session.dispose();
  }
});

// What the branch holds, in order: each message by role, each note by type.
const order = (session) =>
  branchOf(session).flatMap((entry) => {
    if (entry.type === "message") {
      return entry.message.role === "system" ? [] : [entry.message.role];
    }

    return entry.type === "custom_message" ? [`note:${entry.customType}`] : [];
  });

const mastNotesIn = (session) =>
  branchOf(session).filter(
    (entry) =>
      entry.type === "custom_message" && entry.customType === "pi-t3-mast"
  );

const toolTurn = () =>
  piAi.fauxAssistantMessage([piAi.fauxToolCall("bash", { command: "ls" })], {
    stopReason: "toolUse",
  });

const mastLog = async (log) => {
  const lines = await log();

  return lines.filter((line) => line.kind === "mast");
};

const needsSection = { ...DONE, handoffMissing: 0.88 };

test("a finished run without the section is asked for only the section", async () => {
  const { log } = await arrange({ steer: "on" });
  const jev = scripted(needsSection, DONE);

  const { faux, session } = await start("handoff", jev.classify, {
    agentsFiles: [rulesFile],
  });

  try {
    faux.setResponses([
      quits("All done. Tests pass."),
      quits("Nothing needed from you right now."),
    ]);
    await session.prompt("Update the README.");

    assert.deepEqual(order(session), [
      "user",
      "assistant",
      "note:pi-t3-steer",
      "assistant",
    ]);

    const [note] = notesIn(session);

    assert.equal(note.display, true);
    assert.match(note.content, /^Steer · No handoff \(p=0\.88\):/u);
    assert.match(note.content, /Reply with only that section/u);
    assert.equal(
      assistantTexts(session).at(-1),
      "Nothing needed from you right now."
    );

    const lines = await log();

    assert.deepEqual(
      lines.map((line) => [line.verdict.kind, line.nudged]),
      [
        ["done", true],
        ["done", false],
      ]
    );
  } finally {
    session.dispose();
  }
});

test("a run with no handoff rule loaded is never asked for the section", async () => {
  await arrange({ steer: "on" });
  const jev = scripted(needsSection);
  const { faux, session } = await start("no-rule-on", jev.classify);

  try {
    faux.setResponses([quits("All done. Tests pass.")]);
    await session.prompt("Update the README.");

    assert.equal(jev.requests.length, 1);
    assert.equal(jev.requests[0].questions.handoff_missing, undefined);
    assert.deepEqual(notesIn(session), []);
    assert.equal(assistantTexts(session).length, 1);
  } finally {
    session.dispose();
  }
});

// A stand-in for T3's MCP endpoint, which names the calling thread.
const t3Naming = async (threadId) => {
  const server = createServer((request, response) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const message = body === "" ? {} : JSON.parse(body);

      if (message.id === undefined) {
        response.writeHead(202).end();

        return;
      }

      const result =
        message.method === "initialize"
          ? { capabilities: {}, protocolVersion: "2025-06-18" }
          : {
              content: [
                {
                  text: JSON.stringify({ parentThreadId: threadId }),
                  type: "text",
                },
              ],
              isError: false,
              structuredContent: { parentThreadId: threadId },
            };

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: message.id, jsonrpc: "2.0", result }));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.T3_MCP_URL = `http://127.0.0.1:${server.address().port}/mcp`;
  process.env.T3_MCP_BEARER_TOKEN = "test-token";

  return {
    close: () => {
      Reflect.deleteProperty(process.env, "T3_MCP_URL");
      Reflect.deleteProperty(process.env, "T3_MCP_BEARER_TOKEN");
      server.close();
    },
  };
};

test("a delegated child is told to keep going but never asked for the section", async () => {
  const { log } = await arrange({ steer: "on" });
  const t3 = await t3Naming("thread:delegated-task:child-1");
  const jev = scripted(GAVE_UP, needsSection);

  const { faux, session } = await start("child", jev.classify, {
    agentsFiles: [rulesFile],
  });

  try {
    faux.setResponses([
      quits("Next I'll patch src/a.ts."),
      quits("Patched src/a.ts. STATUS: PASS"),
    ]);
    await session.prompt("Patch src/a.ts.");

    assert.equal(jev.requests.length, 2);

    for (const request of jev.requests) {
      assert.equal(request.questions.handoff_missing, undefined);
      assert.equal(request.state.user_rules, undefined);
    }

    const [note, ...rest] = notesIn(session);

    assert.deepEqual(rest, []);
    assert.match(note.content, /^Steer · Stopped early \(p=0\.92\):/u);
    assert.equal(note.details.kind, "early");
    assert.match(assistantTexts(session).at(-1), /^Patched src\/a\.ts\./u);

    const lines = await log();

    assert.deepEqual(
      lines.map((line) => [line.verdict.handoffMissing, line.nudged]),
      [
        [undefined, true],
        [undefined, false],
      ]
    );
  } finally {
    session.dispose();
    t3.close();
  }
});

test("a T3 delegated child that is done is never asked for the section", async () => {
  const { log } = await arrange({ steer: "on" });
  const t3 = await t3Naming("thread:delegated-task:review-1");
  const jev = scripted({ ...DONE, handoffMissing: 0.9 });

  const { session, turn } = await start("t3-child", jev.classify, {
    agentsFiles: [rulesFile],
  });

  try {
    await turn(
      [],
      "Review the diff and reply with a verdict.",
      "VERDICT: APPROVE"
    );

    assert.deepEqual(notesIn(session), []);
    assert.equal(assistantTexts(session).at(-1), "VERDICT: APPROVE");
    assert.equal(jev.requests[0].questions.handoff_missing, undefined);
    assert.equal(jev.requests[0].state.user_rules, undefined);

    const lines = await log();

    assert.deepEqual(
      lines.map((line) => line.nudged),
      [false]
    );
  } finally {
    session.dispose();
    t3.close();
  }
});

test("a thread T3 names as top level still gets the section nudge", async () => {
  await arrange({ steer: "on" });
  const t3 = await t3Naming("thread-top-1");
  const jev = scripted({ ...DONE, handoffMissing: 0.9 }, DONE);

  const { faux, session } = await start("t3-top", jev.classify, {
    agentsFiles: [rulesFile],
  });

  try {
    faux.setResponses([
      quits("All done. Tests pass."),
      quits("**What I need from you**\nNothing needed from you right now."),
    ]);
    await session.prompt("Update the README.");

    const [note, ...rest] = notesIn(session);

    assert.deepEqual(rest, []);
    assert.equal(note.details.kind, "handoff");
  } finally {
    session.dispose();
    t3.close();
  }
});

test("a keep-going note uses up the stop nudge, so a section note after it is held back", async () => {
  await arrange({ steer: "on" });
  const jev = scripted(GAVE_UP, needsSection);

  const { faux, session } = await start("shared-cap", jev.classify, {
    agentsFiles: [rulesFile],
  });

  try {
    faux.setResponses([
      quits("Next I'll patch src/a.ts."),
      quits("Patched src/a.ts."),
    ]);
    await session.prompt("Patch the file.");

    assert.deepEqual(
      notesIn(session).map((note) => note.details.kind),
      ["early"]
    );
    assert.equal(assistantTexts(session).length, 2);
    assert.equal(jev.requests.length, 2, "the capped stop is judged");
  } finally {
    session.dispose();
  }
});

test("every third turn the MAST checks add a note for a mode over its threshold, once", async () => {
  const { log, logText } = await arrange({ steer: "on" });
  const jev = scriptedWith([DONE], [{ 2.3: 0.9 }]);
  const { faux, session } = await start("mast", jev.classify);

  try {
    faux.setResponses([
      ...Array.from({ length: 6 }, toolTurn),
      quits("Refactored the retry module."),
    ]);
    await session.prompt("Refactor the retry module.");

    const [note, ...rest] = mastNotesIn(session);

    assert.deepEqual(rest, []);
    assert.equal(note.display, true);
    assert.match(note.content, /^MAST · Wandered off \(p=0\.90\): /u);
    assert.deepEqual(note.details, { code: "2.3", probability: 0.9 });

    assert.deepEqual(order(session).slice(0, 9), [
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "note:pi-t3-mast",
      "assistant",
    ]);

    assert.equal(jev.mastRequests.length, 2, "turns 3 and 6 are checked");

    const [request] = jev.mastRequests;

    assert.deepEqual(Object.keys(request.questions).toSorted(), [
      "disobey_task_spec",
      "reasoning_action_mismatch",
      "step_repetition",
      "task_derailment",
      "unaware_of_termination",
    ]);
    assert.match(
      request.state.inputs.task,
      /^\[user\]\nRefactor the retry module\./u
    );
    assert.match(request.state.inputs.trace_window, /tool call: bash/u);
    assert.equal(
      request.state.inputs.window_position,
      "The excerpt is the entire log."
    );

    const lines = await mastLog(log);

    assert.deepEqual(
      lines.map((line) => [line.turn, line.fired, line.nudged]),
      [
        [3, ["2.3"], true],
        [6, [], false],
      ]
    );
    assert.equal(lines[0].probabilities["2.3"], 0.9);
    assert.equal(lines[0].probabilities["1.3"], 0);
    assert.equal(lines[0].mode, "on");
    assert.equal(lines[0].session, session.sessionManager.getSessionId());
    const raw = await logText();

    assert.ok(!raw.includes("Refactor"));

    assert.equal(jev.requests.length, 1, "the final stop is judged as before");
  } finally {
    session.dispose();
  }
});

test("a mode that clears and rises again is noted again", async () => {
  await arrange({ steer: "on" });
  const jev = scriptedWith([DONE], [{ 1.3: 0.9 }, {}, { 1.3: 0.9 }]);
  const { faux, session } = await start("rearm", jev.classify);

  try {
    faux.setResponses([...Array.from({ length: 9 }, toolTurn), quits("Done.")]);
    await session.prompt("Run the loop.");

    assert.equal(mastNotesIn(session).length, 2);
    assert.match(mastNotesIn(session)[0].content, /^MAST · Stuck in a loop/u);
  } finally {
    session.dispose();
  }
});

test("MAST 1.5 is dropped right after a stop nudge, and the other modes still fire", async () => {
  const { log } = await arrange({ steer: "on" });
  const jev = scriptedWith([GAVE_UP, DONE], [{}, { 1.3: 0.9, 1.5: 0.9 }]);
  const { faux, session } = await start("after-nudge", jev.classify);

  try {
    faux.setResponses([
      toolTurn(),
      toolTurn(),
      quits("Next I'll patch a.ts."),
      toolTurn(),
      toolTurn(),
      toolTurn(),
      quits("Patched a.ts."),
    ]);
    await session.prompt("Patch a.ts.");

    assert.equal(notesIn(session).length, 1);

    const [note, ...rest] = mastNotesIn(session);

    assert.deepEqual(rest, []);
    assert.match(note.content, /^MAST · Stuck in a loop/u);

    const lines = await mastLog(log);

    assert.deepEqual(
      lines.map((line) => [line.turn, line.fired]),
      [
        [3, []],
        [6, ["1.3"]],
      ]
    );
    assert.equal(
      lines[1].probabilities["1.5"],
      0.9,
      "the score is still logged"
    );
  } finally {
    session.dispose();
  }
});

test("MAST 1.5 is noted when no stop nudge came before it", async () => {
  await arrange({ steer: "on" });
  const jev = scriptedWith([DONE], [{ 1.5: 0.9 }]);
  const { faux, session } = await start("unaware", jev.classify);

  try {
    faux.setResponses([toolTurn(), toolTurn(), toolTurn(), quits("All done.")]);
    await session.prompt("Tidy the repo.");

    const [note] = mastNotesIn(session);

    assert.match(
      note.content,
      /^MAST · Doesn't know when to stop \(p=0\.90\): /u
    );
  } finally {
    session.dispose();
  }
});

test("MAST notes do not use up the stop nudge", async () => {
  await arrange({ steer: "on" });
  const jev = scriptedWith([GAVE_UP], [{ 2.3: 0.9 }]);
  const { faux, session } = await start("mast-cap", jev.classify);

  try {
    faux.setResponses([
      toolTurn(),
      toolTurn(),
      toolTurn(),
      quits("Next I'll patch a.ts."),
      quits("Next I'll patch b.ts."),
    ]);
    await session.prompt("Patch everything.");

    assert.equal(mastNotesIn(session).length, 1);
    assert.equal(notesIn(session).length, 1);
    assert.equal(assistantTexts(session).at(-1), "Next I'll patch b.ts.");
    assert.equal(jev.requests.length, 2, "the capped stop is judged");
  } finally {
    session.dispose();
  }
});

test("a new prompt starts the MAST turn count and arming again", async () => {
  await arrange({ steer: "on" });
  const jev = scriptedWith([DONE], [{ 2.3: 0.9 }]);
  const { faux, session } = await start("mast-prompts", jev.classify);

  try {
    const ask = async (prompt) => {
      faux.setResponses([
        toolTurn(),
        toolTurn(),
        toolTurn(),
        quits(`${prompt} Done.`),
      ]);
      await session.prompt(prompt);
    };

    await ask("First task.");
    await ask("Second task.");

    assert.equal(mastNotesIn(session).length, 2);
    assert.match(
      jev.mastRequests[1].state.inputs.task,
      /^\[user\]\nSecond task\./u
    );
  } finally {
    session.dispose();
  }
});

test("in shadow mode the MAST checks are logged and add no notes", async () => {
  const { log } = await arrange({ steer: "shadow" });
  const jev = scriptedWith([DONE], [{ 2.3: 0.9 }]);
  const { faux, session } = await start("mast-shadow", jev.classify);

  try {
    faux.setResponses([toolTurn(), toolTurn(), toolTurn(), quits("All done.")]);
    await session.prompt("Tidy the repo.");

    assert.deepEqual(mastNotesIn(session), []);
    assert.equal(assistantTexts(session).length, 4);

    const lines = await mastLog(log);

    assert.deepEqual(
      lines.map((line) => [line.mode, line.fired, line.nudged]),
      [["shadow", ["2.3"], false]]
    );
  } finally {
    session.dispose();
  }
});

test("steer off asks no MAST questions", async () => {
  const { log } = await arrange({ steer: "off" });
  const jev = scriptedWith([DONE], [{ 2.3: 0.9 }]);
  const { faux, session } = await start("mast-off", jev.classify);

  try {
    faux.setResponses([toolTurn(), toolTurn(), toolTurn(), quits("All done.")]);
    await session.prompt("Tidy the repo.");

    assert.equal(jev.mastRequests.length, 0);
    assert.deepEqual(mastNotesIn(session), []);
    assert.deepEqual(await log(), []);
  } finally {
    session.dispose();
  }
});

test("a MAST check that fails is logged and changes nothing", async () => {
  const { log } = await arrange({ steer: "on" });

  const { faux, session } = await start("mast-down", (context) =>
    context.questions.stop_kind === undefined
      ? {
          answers: {},
          errorMessage: "Provider is not configured: typesafe",
          stopReason: "error",
        }
      : { answers: answers(context, DONE), stopReason: "stop" }
  );

  try {
    faux.setResponses([toolTurn(), toolTurn(), toolTurn(), quits("All done.")]);
    await session.prompt("Tidy the repo.");

    assert.deepEqual(mastNotesIn(session), []);
    assert.equal(assistantTexts(session).length, 4);

    const lines = await log();

    assert.deepEqual(
      lines.map((line) => [line.kind, line.error, line.nudged]),
      [
        ["mast", "Provider is not configured: typesafe", false],
        ["stop", undefined, false],
      ]
    );
  } finally {
    session.dispose();
  }
});

// A faux chat-model reply to a judge call: the flat arguments of the
// classifier_answers tool.
const judgeReply = (flat) =>
  piAi.fauxAssistantMessage([piAi.fauxToolCall("classifier_answers", flat)], {
    stopReason: "toolUse",
  });

const chatStop = ({ kind, unfinished }) =>
  judgeReply({ stop_kind: kind, unfinished });

const chatMast = (scores) =>
  judgeReply(
    Object.fromEntries(
      Object.entries(MAST_FIELDS).map(([code, field]) => [
        field,
        scores[code] ?? 0,
      ])
    )
  );

test("without Jev the session model judges a stop and the early-stop nudge fires", async () => {
  const { log } = await arrange({ steer: "on" });

  const { faux, session } = await start("no-jev-stop", undefined, {
    jev: false,
  });

  try {
    faux.setResponses([
      quits("Next I'll patch src/retry.ts and run the tests."),
      chatStop(GAVE_UP),
      quits("Patched, and the tests pass."),
      chatStop(DONE),
    ]);
    await session.prompt("Fix the retry bug.");

    assert.equal(notesIn(session).length, 1);
    assert.equal(
      assistantTexts(session).length,
      2,
      "the judge's reply is not part of the session"
    );

    const lines = await log();

    assert.deepEqual(
      lines.map((line) => [line.error, line.nudged]),
      [
        [undefined, true],
        [undefined, false],
      ]
    );
    assert.deepEqual(lines[0].verdict, {
      kind: "gave_up_midway",
      unfinished: 0.92,
    });
  } finally {
    session.dispose();
  }
});

test("a configured classifierModel wins over an available Jev", async () => {
  const { log } = await arrange({
    classifierModel: "faux-chosen/claude-opus-5-5",
    steer: "on",
  });

  const jev = scripted(DONE);
  const { faux, session } = await start("chosen", jev.classify);

  try {
    faux.setResponses([
      quits("Next I'll patch src/retry.ts and run the tests."),
      chatStop(GAVE_UP),
      quits("Patched, and the tests pass."),
      chatStop(DONE),
    ]);
    await session.prompt("Fix the retry bug.");

    assert.equal(jev.requests.length, 0);
    assert.equal(notesIn(session).length, 1);

    const lines = await log();

    assert.deepEqual(
      lines.map((line) => line.nudged),
      [true, false]
    );
  } finally {
    session.dispose();
  }
});

test("a classifierModel that is not in the catalog is an error naming it, and Jev is not used", async () => {
  const { log } = await arrange({
    classifierModel: "nowhere/no-such-model",
    steer: "on",
  });

  const jev = scripted(GAVE_UP);
  const { session, turn } = await start("missing-chosen", jev.classify);

  try {
    await turn([], "Fix the retry bug.", "Next I'll patch src/retry.ts.");

    assert.equal(jev.requests.length, 0);
    assert.deepEqual(notesIn(session), []);

    const [line] = await log();

    assert.match(line.error, /classifierModel "nowhere\/no-such-model"/u);
    assert.equal(line.nudged, false);
  } finally {
    session.dispose();
  }
});

test("without Jev the session model answers a MAST check and the note fires", async () => {
  const { log } = await arrange({ steer: "on" });

  const { faux, session } = await start("no-jev-mast", undefined, {
    jev: false,
  });

  try {
    faux.setResponses([
      toolTurn(),
      toolTurn(),
      toolTurn(),
      chatMast({ 2.3: 0.9 }),
      toolTurn(),
      toolTurn(),
      toolTurn(),
      chatMast({}),
      quits("Refactored the retry module."),
      chatStop(DONE),
    ]);
    await session.prompt("Refactor the retry module.");

    const [note, ...rest] = mastNotesIn(session);

    assert.deepEqual(rest, []);
    assert.match(note.content, /^MAST · Wandered off \(p=0\.90\): /u);
    assert.deepEqual(note.details, { code: "2.3", probability: 0.9 });

    const lines = await mastLog(log);

    assert.deepEqual(
      lines.map((line) => [line.turn, line.error, line.fired]),
      [
        [3, undefined, ["2.3"]],
        [6, undefined, []],
      ]
    );
  } finally {
    session.dispose();
  }
});
