import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionFactory,
  ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const PACKAGE_NAME = "pi-amplike";

const ManifestSchema = Type.Object({ name: Type.String() });

const FactoryModuleSchema = Type.Object({
  default: Type.Function([Type.Unknown()], Type.Unknown()),
});

const ModeUtilsSchema = Type.Object({
  loadModeSpec: Type.Function([Type.String(), Type.String()], Type.Unknown()),
});

const ModeSpecSchema = Type.Object({
  modelId: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(Type.String()),
});

export type ModeSpec = Static<typeof ModeSpecSchema>;

export type LoadModeSpec = (
  cwd: string,
  name: string
) => Promise<ModeSpec | undefined>;

export interface Amplike {
  readonly extensions: readonly string[];
  readonly root: string;
  // True when Pi loads amplike's extensions itself, so this adapter must not.
  readonly selfLoaded: boolean;
  readonly source: string;
}

const isAmplikeRoot = (root: string): boolean => {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf-8")
    );

    return (
      Value.Check(ManifestSchema, manifest) && manifest.name === PACKAGE_NAME
    );
  } catch {
    return false;
  }
};

const isAmplike = (resource: ResolvedResource): boolean =>
  resource.metadata.packageRoot !== undefined &&
  isAmplikeRoot(resource.metadata.packageRoot);

// Pi's own package manager gives the extension files amplike's manifest names,
// and whether the settings entry for amplike turns them off.
export const findAmplike = async (
  cwd: string
): Promise<Amplike | undefined> => {
  const agentDir = getAgentDir();

  const manager = new DefaultPackageManager({
    agentDir,
    cwd,
    settingsManager: SettingsManager.create(cwd, agentDir),
  });

  const resolved = await manager.resolve(async () => "skip");
  const own = resolved.extensions.filter(isAmplike);
  const [first] = own;

  if (first?.metadata.packageRoot === undefined) {
    return undefined;
  }

  return {
    extensions: own.map((resource) => resource.path),
    root: first.metadata.packageRoot,
    selfLoaded: own.some((resource) => resource.enabled),
    source: first.metadata.source,
  };
};

export const loadFactory = async (file: string): Promise<ExtensionFactory> => {
  const module: unknown = await import(file);

  if (!Value.Check(FactoryModuleSchema, module)) {
    throw new TypeError(`${file} has no default extension factory.`);
  }

  // SAFETY: amplike's extension files default-export a Pi extension factory.
  return module.default as ExtensionFactory;
};

// amplike's handoff and subagent read -mode through this helper, so the T3
// replacements read it the same way.
export const loadModeSpecFrom = async (root: string): Promise<LoadModeSpec> => {
  const file = path.join(root, "extensions", "lib", "mode-utils.ts");
  const module: unknown = await import(file);

  if (!Value.Check(ModeUtilsSchema, module)) {
    throw new TypeError(`${file} has no loadModeSpec export.`);
  }

  return async (cwd, name) => {
    const spec = await module.loadModeSpec(cwd, name);

    return Value.Check(ModeSpecSchema, spec) ? spec : undefined;
  };
};
