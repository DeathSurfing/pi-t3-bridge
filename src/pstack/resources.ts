import { existsSync } from "node:fs";
import path from "node:path";

import { materializePstack, overlayDir } from "./overlay.ts";

export interface PstackPaths {
  readonly extensionDir: string;
  readonly pstackRoot: string;
  readonly skillsDir: string;
  readonly upstreamRoot: string;
}

let cached: PstackPaths | undefined;

export const pstackPaths = (): PstackPaths => {
  if (cached) {
    return cached;
  }

  const extensionDir = path.resolve(import.meta.dirname, "../..");
  const upstreamRoot = path.join(extensionDir, "pstack");

  const pstackRoot = materializePstack(upstreamRoot, overlayDir(extensionDir));

  cached = {
    extensionDir,
    pstackRoot,
    skillsDir: path.join(pstackRoot, "skills"),
    upstreamRoot,
  };

  return cached;
};

export const policyPath = (): string =>
  path.join(pstackPaths().pstackRoot, "models.json");

export const skillPaths = (paths: PstackPaths): string[] => {
  if (!existsSync(paths.skillsDir)) {
    return [];
  }

  return [paths.skillsDir];
};
