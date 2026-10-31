import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Type } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { bashTimeoutSeconds } from "../bridge/bash-timeout.ts";
import { appendLedger } from "../bridge/state.ts";
import { ownThreadId } from "../bridge/thread.ts";
import { sessionBrief } from "./brief.ts";
import type { Brief } from "./brief.ts";
import { policyPath } from "./resources.ts";

// Rules a delegated child cannot talk its way around. A session whose first
// message is a pstack brief gets them: writes only inside its workdir (a macOS
// sandbox around every shell command) and only to its listed files (write and
// edit), its time and disk limits, and a report line the code writes from
// commands it runs itself, not from what the model says.

const run = promisify(execFile);

const SANDBOX = "/usr/bin/sandbox-exec";

const DU_TIMEOUT_MS = 15_000;

const SCRATCH = ".scratch/";

const WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

const real = (target: string): string => {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
};

// Where a write to target lands once every symlink on its path is followed.
// Undefined for a dangling link, whose landing spot cannot be known.
const landing = (target: string): string | undefined => {
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    try {
      return realpathSync(target);
    } catch {
      return undefined;
    }
  }

  const parent = path.dirname(target);

  if (parent === target) {
    return target;
  }

  const base = landing(parent);

  return base === undefined
    ? undefined
    : path.join(base, path.basename(target));
};

// Tool caches and installs stay writable, so uv, npm and mise work.
const writableRoots = (workdir: string, gitDir: string | undefined) => {
  const home = homedir();

  return [
    workdir,
    gitDir,
    path.join(home, ".cache"),
    path.join(home, "Library", "Caches"),
    path.join(home, ".npm"),
    path.join(home, ".local", "share", "uv"),
    path.join(home, ".local", "share", "mise"),
    "/private/var/folders",
    "/dev",
  ]
    .filter((root): root is string => root !== undefined)
    .flatMap((root) => [root, real(root)]);
};

// Hooks and config in the git dir run later, outside the sandbox, when the
// parent commits or merges the child's work, so they stay read-only.
const gitDenies = (gitDir: string | undefined): string[] =>
  gitDir === undefined
    ? []
    : [gitDir, real(gitDir)].flatMap((dir) => [
        `(subpath ${JSON.stringify(path.join(dir, "hooks"))})`,
        `(literal ${JSON.stringify(path.join(dir, "config"))})`,
        `(literal ${JSON.stringify(path.join(dir, "config.lock"))})`,
      ]);

const sandboxProfile = (
  roots: readonly string[],
  denies: readonly string[]
): string =>
  [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${[...new Set(roots)].map((root) => `(subpath ${JSON.stringify(root)})`).join(" ")})`,
    ...(denies.length === 0
      ? []
      : [`(deny file-write* ${[...new Set(denies)].join(" ")})`]),
  ].join("");

const globToRegExp = (glob: string): RegExp => {
  const source = glob
    .replace(/^\.\//u, "")
    .replace(/\/\*\*$/u, "\u0002")
    .replaceAll(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**/", "\u0000")
    .replaceAll("**", "\u0001")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]")
    .replaceAll("\u0000", "(?:.*/)?")
    .replaceAll("\u0001", ".*")
    .replaceAll("\u0002", "(?:/.*)?");

  return new RegExp(`^${source}/?$`, "u");
};

export const allowedFile = (brief: Brief, relative: string): boolean =>
  relative.startsWith(SCRATCH) ||
  brief.files.some((file) => globToRegExp(file).test(relative));

const duKb = async (target: string): Promise<number | undefined> => {
  try {
    const { stdout } = await run("du", ["-sk", target], {
      timeout: DU_TIMEOUT_MS,
    });

    return Number(stdout.split(/\s/u)[0]);
  } catch {
    return undefined;
  }
};

const remainingSeconds = (startedAt: number, brief: Brief): number =>
  brief.minutes === undefined
    ? Number.POSITIVE_INFINITY
    : startedAt / 1000 + brief.minutes * 60 - Date.now() / 1000;

const ExecFailureSchema = Type.Object({
  code: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  killed: Type.Optional(Type.Boolean()),
  stderr: Type.Optional(Type.String()),
  stdout: Type.Optional(Type.String()),
});

const PolicySchema = Type.Object({
  briefs: Type.Optional(
    Type.Object({ redBeforeGreen: Type.Optional(Type.Array(Type.String())) })
  ),
});

const BashInputSchema = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(Type.Unknown()),
});

const PathInputSchema = Type.Object({ path: Type.String() });

const readRedBeforeGreen = (): readonly string[] => {
  const policy: unknown = JSON.parse(readFileSync(policyPath(), "utf-8"));

  return Value.Check(PolicySchema, policy)
    ? (policy.briefs?.redBeforeGreen ?? [])
    : [];
};

const changedFiles = async (cwd: string): Promise<string[]> => {
  try {
    const { stdout } = await run(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd }
    );

    return stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.slice(3).split(" -> ").pop() ?? "");
  } catch {
    return [];
  }
};

const reportStatus = (
  blocked: boolean,
  accepted: { exit: number },
  outside: readonly string[]
): "BLOCKED" | "ISSUES" | "PASS" => {
  if (blocked) {
    return "BLOCKED";
  }

  return accepted.exit === 0 && outside.length === 0 ? "PASS" : "ISSUES";
};

const diskGrowthMb = (
  nowKb: number | undefined,
  baselineKb: number | undefined
): number | undefined =>
  nowKb === undefined || baselineKb === undefined
    ? undefined
    : Math.max(0, (nowKb - baselineKb) / 1024);

const overLimit = (
  grownMb: number | undefined,
  limitMb: number | undefined
): boolean =>
  grownMb !== undefined && limitMb !== undefined && grownMb > limitMb;

interface Report {
  readonly accepted: { exit: number; tail: string };
  readonly before: number | undefined;
  readonly brief: Brief;
  readonly changed: number;
  readonly diskMb: number | undefined;
  readonly minutes: number;
  readonly outside: readonly string[];
  readonly status: string;
}

const reportBlock = (report: Report): string => {
  const { accepted, brief, diskMb, minutes, outside } = report;
  const tail = accepted.tail.trim().split("\n").slice(-10).join("\n");

  const before =
    report.before === undefined ? "" : ` (before: exit ${report.before})`;

  return [
    "",
    "---",
    "## Checked by pi-t3-bridge (run by code, not written by the model)",
    `STATUS: ${report.status}`,
    `ACCEPTANCE: \`${brief.acceptance ?? ""}\` -> exit ${accepted.exit}${before}`,
    ...(tail === "" ? [] : ["```text", tail, "```"]),
    `FILES: ${report.changed} changed; outside the list: ${outside.length === 0 ? "none" : outside.join(", ")}`,
    `DISK: ${diskMb === undefined ? "unknown" : `+${diskMb.toFixed(1)} MB`} in the workdir (limit ${brief.diskMb ?? "?"} MB)`,
    `TIME: ${minutes.toFixed(1)} of ${brief.minutes ?? "?"} min`,
  ].join("\n");
};

interface ChildState {
  baselineKb: number | undefined;
  before: number | undefined;
  diskCheck: Promise<void>;
  diskOver: boolean;
  diskQueued: boolean;
  gitDir: string | undefined;
  greenAtStart: boolean;
  ready: boolean;
}

export const registerChild = (pi: ExtensionAPI): void => {
  const state: ChildState = {
    baselineKb: undefined,
    before: undefined,
    diskCheck: Promise.resolve(),
    diskOver: false,
    diskQueued: false,
    gitDir: undefined,
    greenAtStart: false,
    ready: false,
  };

  const sandboxed = (command: string, workdir: string): string =>
    existsSync(SANDBOX)
      ? `${SANDBOX} -p ${quote(sandboxProfile(writableRoots(workdir, state.gitDir), gitDenies(state.gitDir)))} /bin/bash -c ${quote(command)}`
      : command;

  const runAcceptance = async (
    command: string,
    workdir: string,
    seconds: number
  ): Promise<{ exit: number; tail: string }> => {
    try {
      const { stdout, stderr } = await run(
        "/bin/bash",
        ["-c", sandboxed(command, workdir)],
        { cwd: workdir, maxBuffer: 16 * 1024 * 1024, timeout: seconds * 1000 }
      );

      return { exit: 0, tail: `${stdout}${stderr}` };
    } catch (error) {
      const failed = Value.Check(ExecFailureSchema, error) ? error : {};

      const exit = Value.Check(Type.Number(), failed.code) ? failed.code : 124;

      return {
        exit,
        tail: `${failed.stdout ?? ""}${failed.stderr ?? ""}${failed.killed ? "\n(timed out)" : ""}`,
      };
    }
  };

  const prepare = async (ctx: ExtensionContext, brief: Brief) => {
    if (state.ready) {
      return;
    }

    state.ready = true;

    try {
      const { stdout } = await run("git", ["rev-parse", "--git-common-dir"], {
        cwd: ctx.cwd,
      });

      state.gitDir = path.resolve(ctx.cwd, stdout.trim());
    } catch {
      state.gitDir = undefined;
    }

    state.baselineKb = await duKb(ctx.cwd);

    const redBeforeGreen = readRedBeforeGreen();

    if (
      brief.acceptance !== undefined &&
      brief.job !== undefined &&
      redBeforeGreen.includes(brief.job)
    ) {
      const { exit } = await runAcceptance(
        brief.acceptance,
        ctx.cwd,
        bashTimeoutSeconds()
      );

      state.before = exit;
      state.greenAtStart = exit === 0;
    }
  };

  pi.on("before_agent_start", async (_event, ctx) => {
    const started = sessionBrief(ctx);

    if (started !== undefined) {
      await prepare(ctx, started.brief);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const started = sessionBrief(ctx);

    if (started === undefined) {
      return;
    }

    const { brief, startedAt } = started;

    await prepare(ctx, brief);
    await state.diskCheck;

    if (state.greenAtStart) {
      return {
        block: true,
        reason:
          "The acceptance command already passes before any change (exit 0), so it checks nothing. Make no changes. Report STATUS: BLOCKED and say the acceptance command already passes.",
      };
    }

    const remaining = remainingSeconds(startedAt, brief);

    if (remaining <= 0) {
      return {
        block: true,
        reason: `The time limit of ${brief.minutes} min is reached. Use no more tools. Report now with STATUS: BLOCKED (time limit) and what is left.`,
      };
    }

    if (state.diskOver) {
      return {
        block: true,
        reason: `The disk limit of ${brief.diskMb} MB is reached in the workdir. Use no more tools. Report STATUS: BLOCKED (disk limit) and what used the space.`,
      };
    }

    const { input } = event;

    if (event.toolName === "bash" && Value.Check(BashInputSchema, input)) {
      const limit = Math.max(1, Math.ceil(remaining));

      input.timeout = Value.Check(Type.Number(), input.timeout)
        ? Math.min(input.timeout, limit)
        : limit;
      input.command = sandboxed(input.command, ctx.cwd);

      return;
    }

    if (
      WRITE_TOOLS.has(event.toolName) &&
      Value.Check(PathInputSchema, input)
    ) {
      const absolute = landing(
        path.resolve(ctx.cwd, input.path.replace(/^~(?=\/)/u, homedir()))
      );

      const relative =
        absolute === undefined
          ? undefined
          : path.relative(real(ctx.cwd), absolute);

      if (
        relative === undefined ||
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        !allowedFile(brief, relative)
      ) {
        return {
          block: true,
          reason: `${input.path} is not in "Files you may write" (${brief.files.join(", ")}). Stop and report BLOCKED if the task needs it.`,
        };
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const started = sessionBrief(ctx);

    if (
      started === undefined ||
      event.toolName !== "bash" ||
      state.diskQueued
    ) {
      return;
    }

    const { diskMb } = started.brief;
    const { cwd } = ctx;

    // Measured while the model thinks. The next tool call waits for it. One
    // du runs at a time, and a burst of results queues at most one more,
    // which starts after them all. ctx throws once the session is gone, so
    // cwd is read before the handler returns.
    const previous = state.diskCheck;

    state.diskQueued = true;
    state.diskCheck = (async () => {
      await previous;

      state.diskQueued = false;

      const now = await duKb(cwd);

      if (
        now !== undefined &&
        state.baselineKb !== undefined &&
        diskMb !== undefined &&
        (now - state.baselineKb) / 1024 > diskMb
      ) {
        state.diskOver = true;
      }
    })();
  });

  pi.on("message_end", async (event, ctx) => {
    const { message } = event;
    const started = sessionBrief(ctx);

    if (
      started === undefined ||
      message.role !== "assistant" ||
      message.stopReason !== "stop"
    ) {
      return;
    }

    const { brief, startedAt } = started;

    await prepare(ctx, brief);
    await state.diskCheck;

    const accepted =
      brief.acceptance === undefined
        ? { exit: 2, tail: "no acceptance command" }
        : await runAcceptance(brief.acceptance, ctx.cwd, bashTimeoutSeconds());

    const changed = await changedFiles(ctx.cwd);

    const outside = changed.filter((file) => !allowedFile(brief, file));
    const diskMb = diskGrowthMb(await duKb(ctx.cwd), state.baselineKb);

    const minutes = (Date.now() - startedAt) / 60_000;
    const overTime = brief.minutes !== undefined && minutes > brief.minutes;

    const diskOver = state.diskOver || overLimit(diskMb, brief.diskMb);

    const status = reportStatus(
      state.greenAtStart || overTime || diskOver,
      accepted,
      outside
    );

    const block = reportBlock({
      accepted,
      before: state.before,
      brief,
      changed: changed.length,
      diskMb,
      minutes,
      outside,
      status,
    });

    // The bridge writes this child's cost in a line of its own.
    appendLedger({
      at: new Date().toISOString(),
      before: state.before ?? null,
      diskMb: diskMb === undefined ? null : Number(diskMb.toFixed(1)),
      exit: accepted.exit,
      job: brief.job ?? null,
      minutes: Number(minutes.toFixed(1)),
      outside: outside.length,
      report: block,
      size: brief.size ?? null,
      status,
      threadId: await ownThreadId(),
      workdir: ctx.cwd,
    });

    return {
      message: {
        ...message,
        content: [...message.content, { text: block, type: "text" }],
      },
    };
  });
};
