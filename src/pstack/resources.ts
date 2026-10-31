import { existsSync } from "node:fs";
import path from "node:path";

export interface PstackPaths {
  readonly extensionDir: string;
  readonly pstackRoot: string;
  readonly skillsDir: string;
}

export const pstackPaths = (): PstackPaths => {
  const extensionDir = path.resolve(import.meta.dirname, "../..");
  const pstackRoot = path.join(extensionDir, "pstack");

  return {
    extensionDir,
    pstackRoot,
    skillsDir: path.join(pstackRoot, "skills"),
  };
};

export const policyPath = (): string =>
  path.join(pstackPaths().pstackRoot, "models.json");

export const skillPaths = (paths: PstackPaths): string[] => {
  if (!existsSync(paths.skillsDir)) {
    return [];
  }

  return [paths.skillsDir];
};
