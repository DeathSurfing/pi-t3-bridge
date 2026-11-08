// Calls one tool on T3's MCP endpoint directly, with the thread's own token.
// Lifecycle handlers such as agent_end get no ctx.executeTool, and the
// orchestrator has to schedule its resume exactly when its own model failed.

const TIMEOUT_MS = 15_000;

const PROTOCOL_VERSION = "2025-06-18";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

interface JsonRpcReply {
  readonly error?: { readonly message?: string };
  readonly result?: {
    readonly content?: readonly { readonly text?: string }[];
    readonly isError?: boolean;
    readonly structuredContent?: JsonValue;
  };
}

export const insideT3 = (): boolean => Boolean(process.env.T3_MCP_URL?.trim());

const parseReply = (contentType: string, body: string): JsonRpcReply => {
  if (!contentType.includes("text/event-stream")) {
    // SAFETY: T3's MCP endpoint answers with a JSON-RPC reply; every field is read optionally.
    return JSON.parse(body) as JsonRpcReply;
  }

  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .findLast((line) => line.startsWith("{"));

  // SAFETY: same JSON-RPC reply shape as above, carried in an event-stream data line.
  return JSON.parse(data ?? "{}") as JsonRpcReply;
};

const post = async (
  url: string,
  headers: Headers,
  message: Readonly<Record<string, JsonValue>>
): Promise<{ body: string; response: Response }> => {
  const response = await fetch(url, {
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    headers,
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`T3 MCP answered ${response.status}`);
  }

  return { body, response };
};

const replyResult = (name: string, reply: JsonRpcReply): JsonValue => {
  if (reply.error !== undefined || reply.result?.isError === true) {
    throw new Error(
      `${name} failed: ${reply.error?.message ?? reply.result?.content?.[0]?.text ?? "unknown error"}`
    );
  }

  return (
    reply.result?.structuredContent ??
    JSON.parse(reply.result?.content?.[0]?.text ?? "null")
  );
};

// T3 holds an open session until it expires, so each call closes its own.
const closeSession = async (url: string, headers: Headers): Promise<void> => {
  try {
    const response = await fetch(url, {
      headers,
      method: "DELETE",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    await response.body?.cancel();
  } catch {
    // T3 expires a session it never got to close.
  }
};

export const callT3Tool = async (
  name: string,
  args: Readonly<Record<string, JsonValue>>
): Promise<JsonValue> => {
  const url = process.env.T3_MCP_URL?.trim() ?? "";

  const headers = new Headers({
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${process.env.T3_MCP_BEARER_TOKEN ?? ""}`,
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
  });

  const init = await post(url, headers, {
    id: 1,
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "pi-t3", version: "0" },
      protocolVersion: PROTOCOL_VERSION,
    },
  });

  const session = init.response.headers.get("mcp-session-id");

  if (session !== null) {
    headers.set("mcp-session-id", session);
  }

  try {
    await post(url, headers, { method: "notifications/initialized" });

    const call = await post(url, headers, {
      id: 2,
      method: "tools/call",
      params: { arguments: args, name },
    });

    return replyResult(
      name,
      parseReply(call.response.headers.get("content-type") ?? "", call.body)
    );
  } finally {
    if (session !== null) {
      await closeSession(url, headers);
    }
  }
};
