import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const extensionDir = path.dirname(import.meta.dirname);

const extensionPaths = ["bridge.ts", "pstack.ts"].map((file) =>
  path.join(extensionDir, file)
);

const bridge = path.join(homedir(), ".t3/caches/pi-t3-mcp-extension.ts");

const probe = path.join(import.meta.dirname, "fixtures/request-probe.ts");
const artifact = path.join(extensionDir, "artifacts", "bridge-trim.json");

const skip =
  (!process.env.T3_MCP_URL &&
    "needs a T3 thread, whose MCP server lists T3's tools") ||
  (!existsSync(bridge) && "T3 has not written its Pi bridge");

const nativeSubagents = /- Subagents: [^\\]*Codex `spawn_agent`/u;

// Starts Pi the way T3 does, with T3's own bridge connected to the live T3,
// and returns the first provider request it would send.
const firstRequest = async (extensions, message = "hi") => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-trim-"));
  const out = path.join(dir, "request.json");

  try {
    const args = [
      "--mode",
      "rpc",
      "--no-session",
      "-ne",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet-4-5",
      "--api-key",
      "unused",
    ];

    for (const extension of [
      "builtin:tool-search",
      bridge,
      ...extensions,
      probe,
    ]) {
      args.push("-e", extension);
    }

    const child = spawn("pi", args, {
      cwd: dir,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: path.join(dir, "agent"),
        REQUEST_PROBE_OUT: out,
        T3_PI_MCP_EXTENSION_PATH: bridge,
        T3_PI_RUNTIME_MODE: "full-access",
      },
      stdio: ["pipe", "ignore", "ignore"],
    });

    child.stdin.write(
      `${JSON.stringify({ id: "p", message, type: "prompt" })}\n`
    );

    // Pi needs a moment to start and connect the bridge; poll for the request.
    /* oxlint-disable no-await-in-loop */
    for (let waited = 0; !existsSync(out) && waited < 30_000; waited += 200) {
      await sleep(200);
    }
    /* oxlint-enable no-await-in-loop */

    child.kill("SIGTERM");

    return await readFile(out, "utf-8");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

test(
  "the bridge routes Pi subagents through T3 in each provider request",
  { skip },
  async () => {
    const before = await firstRequest([]);
    const after = await firstRequest(extensionPaths);

    const quoted =
      "Quoted example:\n- Subagents: use your native tool (Claude `Agent`; Codex `spawn_agent`).";

    const quotedRequest = JSON.parse(
      await firstRequest(extensionPaths, quoted)
    );

    assert.equal(quotedRequest.messages[0].content[0].text, quoted);

    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(
      artifact,
      `${JSON.stringify({ after: after.length, at: new Date().toISOString(), before: before.length, nativeAfter: nativeSubagents.test(after), nativeBefore: nativeSubagents.test(before) }, null, 2)}\n`
    );

    assert.match(
      before,
      nativeSubagents,
      "T3's bridge text no longer sends subagents to native tools"
    );
    assert.doesNotMatch(after, nativeSubagents);
    assert.match(after, /## T3 Code orchestration/u);
    assert.match(after, /Subagents: use `delegate_task` for subagent work/u);
    assert.match(
      after,
      /Call `orchestrator_capabilities` once per thread/u,
      "a cut removed text Pi still uses"
    );
  }
);
