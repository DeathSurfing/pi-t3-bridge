// What a delegated child waits on around each bash call: the tool_result hook
// (where pi-t3-bridge checks disk use) and the next tool_call hook, with a gap
// standing in for the model's think time between calls.
// Usage: CHILD_CWD=<worktree> GAP_MS=<ms> node tests/perf/child-du.mjs <runs>
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const piRoot =
  "/Users/bsa/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent";

const {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} = await import(pathToFileURL(path.join(piRoot, "dist/index.js")));

const EXTENSIONS = ["bridge.ts", "pstack.ts"].map((file) =>
  path.resolve(import.meta.dirname, "../..", file)
);

const CWD = process.env.CHILD_CWD;
const GAP = Number(process.env.GAP_MS ?? 0);
const runs = Number(process.argv[2] ?? 20);

const agentDir = mkdtempSync(path.join(tmpdir(), "child-du-"));

mkdirSync(path.join(agentDir, "a"));

const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});

const loader = new DefaultResourceLoader({
  additionalExtensionPaths: EXTENSIONS,
  agentDir,
  cwd: CWD,
  noContextFiles: true,
  noExtensions: true,
  noPromptTemplates: true,
  noSkills: true,
  noThemes: true,
  settingsManager,
});

await loader.reload();

const brief = readFileSync(new URL("child-brief.md", import.meta.url), "utf-8");
const manager = SessionManager.inMemory(CWD);

manager.appendMessage({ content: brief, role: "user", timestamp: Date.now() });

const { session } = await createAgentSession({
  agentDir,
  cwd: CWD,
  resourceLoader: loader,
  sessionManager: manager,
  settingsManager,
  tools: [],
});

await session.bindExtensions({
  mode: "rpc",
  onError: (e) => console.error(String(e.error ?? e)),
});

const r = session.extensionRunner;

const call = (i) => ({
  input: { command: "true" },
  toolCallId: `c${i}`,
  toolName: "bash",
  type: "tool_call",
});

const result = (i) => ({
  content: [{ text: "ok", type: "text" }],
  details: undefined,
  input: { command: "true" },
  isError: false,
  toolCallId: `c${i}`,
  toolName: "bash",
  type: "tool_result",
});

const unblocked = (outcome) => {
  if (outcome?.block) {
    throw new Error(`child blocked: ${outcome.reason}`);
  }
};

await r.emitBeforeAgentStart(
  { messageType: "user", prompt: brief },
  { cwd: CWD, sections: {}, selectedTools: [] }
);

unblocked(await r.emitToolCall(call(0)));

const rows = [];

// Each call is timed alone, in order, as a child makes them.
/* oxlint-disable no-await-in-loop */
for (let i = 1; i <= runs; i += 1) {
  const resultStart = performance.now();

  await r.emitToolResult(result(i));

  const resultMs = performance.now() - resultStart;

  await sleep(GAP);

  const callStart = performance.now();
  const outcome = await r.emitToolCall(call(i));
  const callMs = performance.now() - callStart;

  unblocked(outcome);
  rows.push({ callMs, resultMs, waitMs: resultMs + callMs });
}
/* oxlint-enable no-await-in-loop */

const sorted = (k) => rows.map((x) => x[k]).toSorted((a, b) => a - b);

const median = (k) => sorted(k)[Math.floor(rows.length / 2)];

const range = (k) => [sorted(k)[0], sorted(k).at(-1)];

console.log(
  JSON.stringify({
    cwd: CWD,
    gapMs: GAP,
    median: {
      call: median("callMs"),
      result: median("resultMs"),
      wait: median("waitMs"),
    },
    runs,
    waitRange: range("waitMs"),
  })
);

session.dispose?.();
