import { compile, obj, str, unknown } from "@earendil-works/pi-schema";
import type { Validator } from "@earendil-works/pi-schema";

const isResultEnvelope = compile(
  obj({ structuredContent: unknown() }, { open: true })
).check;

const isTextPart = compile(obj({ text: str() }, { open: true })).check;

interface ToolOutput {
  readonly content: readonly unknown[];
  readonly structuredContent?: unknown;
}

const textOf = (content: readonly unknown[]): string =>
  content.map((part) => (isTextPart(part) ? part.text : "")).join("");

// T3's in-thread bridge passes the whole MCP result as structuredContent,
// a direct MCP client passes the server's structuredContent itself, and
// some results carry their data only as JSON text.
export const t3Json = <T>(
  validator: Validator<T>,
  output: ToolOutput
): T | undefined => {
  const structured = output.structuredContent;

  const fromStructured = [
    isResultEnvelope(structured) ? structured.structuredContent : undefined,
    structured,
  ].find((candidate) => validator.check(candidate));

  if (validator.check(fromStructured)) {
    return fromStructured;
  }

  try {
    const parsed = JSON.parse(textOf(output.content));

    return validator.check(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const t3Text = (output: ToolOutput): string => textOf(output.content);
