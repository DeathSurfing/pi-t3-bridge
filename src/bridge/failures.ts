// What a provider failure means for routing. The patterns come from every
// distinct terminal failure T3 recorded (tests/fixtures/t3-failures.json):
// T3 titles only some quota failures "Usage limit reached", and labels the rest,
// such as ChatGPT's, "Provider error", so the message decides.

interface Failure {
  readonly class?: string | null;
  readonly message: string;
  readonly resetAt?: string | null;
}

type FailureKind = "exhausted" | "unhealthy" | "other";

export interface Classified {
  readonly kind: FailureKind;
  readonly resetAt?: string;
}

// cliproxy reports a family with no healthy account as auth_unavailable, most
// often after an upstream overload. It recovers on its own, so the family
// waits this long instead of until the user reports recovery.
const UNHEALTHY_MS = 15 * 60_000;

const EXHAUSTED =
  /usage limit|quota exhausted|rate limit reached|usage window resets/iu;

// Anthropic's 429 names no reset time, and it reaches this extension only after Pi's
// own retries failed. The family waits this long, then the next try decides.
const RATE_LIMITED_MS = 15 * 60_000;

const RATE_LIMITED =
  /rate_limit_error|would exceed your account's rate limit/iu;

const UNHEALTHY =
  /auth_unavailable|overloaded|bad gateway|fetch failed|websocket error|stream disconnected|closed unexpectedly|could not start this turn|gateway_timeout/iu;

const RETRY_IN = /try again in ~?\s*(?<minutes>\d+)\s*min/iu;

const RESETS_AT = /resets at (?<time>\d{4}-\d{2}-\d{2}T[\d:.]+Z)/u;

const iso = (time: number): string => new Date(time).toISOString();

const validTime = (text: string | null | undefined): string | undefined => {
  if (text === undefined || text === null) {
    return undefined;
  }

  const time = Date.parse(text);

  return Number.isNaN(time) ? undefined : iso(time);
};

const resetFrom = (failure: Failure, now: number): string | undefined => {
  const minutes = RETRY_IN.exec(failure.message)?.[1];

  return (
    validTime(failure.resetAt) ??
    validTime(RESETS_AT.exec(failure.message)?.[1]) ??
    (minutes === undefined ? undefined : iso(now + Number(minutes) * 60_000))
  );
};

export const classifyFailure = (
  failure: Failure,
  now = Date.now()
): Classified => {
  if (failure.class === "usage_limit" || EXHAUSTED.test(failure.message)) {
    const resetAt = resetFrom(failure, now);

    return resetAt === undefined
      ? { kind: "exhausted" }
      : { kind: "exhausted", resetAt };
  }

  if (RATE_LIMITED.test(failure.message)) {
    return {
      kind: "exhausted",
      resetAt: resetFrom(failure, now) ?? iso(now + RATE_LIMITED_MS),
    };
  }

  if (failure.class === "transport_error" || UNHEALTHY.test(failure.message)) {
    return { kind: "unhealthy", resetAt: iso(now + UNHEALTHY_MS) };
  }

  return { kind: "other" };
};
