import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  compile,
  lit,
  map,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

// Machine-wide bridge state, shared by every Pi session: which model families
// are out of usage, and one ledger line per delegated brief.

const stateHome = (): string =>
  process.env.XDG_STATE_HOME?.trim() || path.join(homedir(), ".local", "state");

const stateDir = (): string => path.join(stateHome(), "pi-t3");

// Releases before the bridge had its own name kept this state under
// t3-pstack. The first load after the rename moves it once, so out-of-usage
// marks and the cost ledger carry over. A failed move leaves both alone.
export const moveOldState = (): void => {
  const old = path.join(stateHome(), "t3-pstack");

  if (existsSync(stateDir()) || !existsSync(old)) {
    return;
  }

  try {
    renameSync(old, stateDir());
  } catch {
    // The bridge starts with empty state instead.
  }
};

const FamilyRecordSchema = union([
  obj(
    {
      reason: oneOf(["exhausted", "unhealthy"]),
      resetAt: opt(str()),
      since: str(),
      source: oneOf(["delegate", "user"]),
      state: lit("exhausted"),
    },
    { open: true }
  ),
  obj(
    { childThreadId: str(), since: str(), state: lit("probing") },
    { open: true }
  ),
]);

const AccountsFileSchema = obj(
  { families: map(FamilyRecordSchema) },
  { open: true }
);

const isAccountsFile = compile(AccountsFileSchema).check;

export type FamilyRecord = Static<typeof FamilyRecordSchema>;

type AccountsFile = Static<typeof AccountsFileSchema>;

const accountsPath = (): string => path.join(stateDir(), "accounts.json");

export const readFamilies = (): AccountsFile["families"] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(accountsPath(), "utf-8"));

    return isAccountsFile(parsed) ? parsed.families : {};
  } catch {
    return {};
  }
};

// Write to a temporary file and rename it over the old one, so a session
// reading at the same time sees the old state or the new one, never half.
export const updateFamily = (family: string, record?: FamilyRecord): void => {
  const families = Object.fromEntries(
    Object.entries(readFamilies()).filter(([name]) => name !== family)
  );

  if (record !== undefined) {
    families[family] = record;
  }

  mkdirSync(stateDir(), { recursive: true });

  const target = accountsPath();
  const temporary = `${target}.${process.pid}.tmp`;

  writeFileSync(temporary, `${JSON.stringify({ families }, null, 2)}\n`);
  renameSync(temporary, target);
};

export const appendLedger = (
  line: Record<string, string | number | null>
): void => {
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(
    path.join(stateDir(), "ledger.jsonl"),
    `${JSON.stringify(line)}\n`
  );
};

// One line per steer check, beside the ledger. It holds the verdict and never
// transcript text. A log that cannot be written must not break a session.
export const appendSteerLog = (line: {
  readonly error?: string;
  readonly fired?: readonly string[];
  readonly kind: string;
  readonly mode: string;
  readonly model: string;
  readonly nudged: boolean;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly session: string;
  readonly turn?: number;
  readonly verdict?: {
    readonly handoffMissing?: number | undefined;
    readonly kind: string;
    readonly unfinished: number;
  };
}): void => {
  try {
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(
      path.join(stateDir(), "steer.jsonl"),
      `${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`
    );
  } catch {
    // Nothing to do: the check already ran.
  }
};

const LedgerLineSchema = obj(
  {
    cacheRead: opt(num()),
    cacheWrite: opt(num()),
    cost: opt(num()),
    input: opt(num()),
    job: opt(nullable(str())),
    minutes: opt(num()),
    model: opt(nullable(str())),
    report: opt(str()),
    status: opt(str()),
    threadId: opt(nullable(str())),
    tokens: opt(num()),
  },
  { open: true }
);

const isLedgerLine = compile(LedgerLineSchema).check;

export type LedgerLine = Static<typeof LedgerLineSchema>;

export const readLedger = (): LedgerLine[] => {
  try {
    return readFileSync(path.join(stateDir(), "ledger.jsonl"), "utf-8")
      .split("\n")
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);

          return isLedgerLine(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};
