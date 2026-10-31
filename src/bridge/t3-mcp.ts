import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { readConfig } from "./config.ts";
import { insideT3 } from "./t3-http.ts";

const SERVER_NAME = "t3";
const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;
const STATUS_KEY = "t3-mcp";
const DEFAULT_URL = "http://127.0.0.1:3773/mcp";
const PROBE_TIMEOUT_MS = 1500;
const REFRESH_INTERVAL_MS = 3000;
const AUTH_FAILURE = /sign.?in|unauthori[sz]ed|\b401\b|authoriz/iu;

// T3 refuses these outside a T3 thread because they act as the calling thread.
// Hiding them keeps the model from choosing a tool that cannot work here.
const THREAD_ONLY_TOOLS = [
  "create_threads",
  "delegate_task",
  "device_*",
  "html_*",
  "preview_*",
  "request_secret",
  "t3_preview_*",
  "t3_worktree_handoff",
  "t3_worktree_status",
  "task_cancel",
  "task_status",
] as const;

const hiddenThreadOnlyTools = Object.fromEntries(
  THREAD_ONLY_TOOLS.map((pattern) => [pattern, "hidden" as const])
);

type T3McpState =
  | { readonly kind: "connecting" }
  | { readonly kind: "offline" }
  | { readonly kind: "sign-in" }
  | { readonly kind: "connected"; readonly tools: number };

interface T3McpObservation {
  readonly authFailed: boolean;
  readonly firstCheck: boolean;
  readonly liveTools: number;
  readonly reachable: boolean;
}

const deriveState = (observation: T3McpObservation): T3McpState => {
  if (!observation.reachable) {
    return { kind: "offline" };
  }

  if (observation.liveTools === 0 && observation.firstCheck) {
    return { kind: "connecting" };
  }

  if (observation.authFailed || observation.liveTools === 0) {
    return { kind: "sign-in" };
  }

  return { kind: "connected", tools: observation.liveTools };
};

const statusText = (state: T3McpState): string => {
  switch (state.kind) {
    case "connected": {
      return `T3 MCP ● connected, ${state.tools} ${state.tools === 1 ? "tool" : "tools"}`;
    }

    case "connecting": {
      return "T3 MCP ○ connecting";
    }

    case "offline": {
      return "T3 MCP ○ offline, start T3 Code";
    }

    default: {
      return `T3 MCP ○ not signed in, run /mcp login ${SERVER_NAME}`;
    }
  }
};

const serverUrl = (): string => readConfig().mcpUrl ?? DEFAULT_URL;

const metadataUrl = (url: string): string =>
  new URL("/.well-known/oauth-protected-resource", url).href;

const probeReachable = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(metadataUrl(url), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    await response.body?.cancel();

    return response.ok;
  } catch {
    return false;
  }
};

const textOf = (content: readonly (TextContent | ImageContent)[]): string =>
  content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

export const registerT3Mcp = (pi: ExtensionAPI): void => {
  if (insideT3()) {
    return;
  }

  const url = serverUrl();

  pi.registerMcpServer(SERVER_NAME, {
    description:
      "T3 Code app tools: launch, steer, and wait on T3 threads (t3_thread_launch, t3_thread_send, t3_thread_wait), schedules, projects, queues, and pull request watching. Outside a T3 thread, list tools need a projectId from t3_project_list.",
    toolExposure: hiddenThreadOnlyTools,
    url,
  });

  let authFailed = false;
  let firstCheck = true;
  let timer: ReturnType<typeof setInterval> | undefined;

  const liveTools = (): number =>
    pi
      .getAllTools()
      .filter(
        (tool) =>
          tool.name.startsWith(TOOL_PREFIX) && tool.exposure !== "hidden"
      ).length;

  const refresh = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      return;
    }

    const reachable = await probeReachable(url);

    const state = deriveState({
      authFailed,
      firstCheck,
      liveTools: liveTools(),
      reachable,
    });

    firstCheck = false;

    ctx.ui.setStatus(STATUS_KEY, statusText(state));
  };

  const stopTimer = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    stopTimer();
    firstCheck = true;
    await refresh(ctx);

    if (ctx.mode === "tui") {
      timer = setInterval(async () => {
        try {
          await refresh(ctx);
        } catch {
          stopTimer();
        }
      }, REFRESH_INTERVAL_MS);
      timer.unref();
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!event.toolName.startsWith(TOOL_PREFIX)) {
      return;
    }

    authFailed = event.isError && AUTH_FAILURE.test(textOf(event.content));
    await refresh(ctx);
  });

  pi.on("session_shutdown", stopTimer);
};
