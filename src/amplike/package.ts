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
import { compile, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

const PACKAGE_NAME = "pi-amplike";

const isManifest = compile(obj({ name: str() }, { open: true })).check;

// JSON Schema has no function type, so these check that the export exists and
// isFunction checks that it is a function. Like TypeBox's Type.Function, the
// check can't see the function's parameters, so the caller names them.
const isFunction = <F extends (...args: never[]) => void>(
  value: unknown
): value is F => typeof value === "function";

const isFactoryModule = compile(
  obj({ default: unknown() }, { open: true })
).check;

const isModeUtils = compile(
  obj({ loadModeSpec: unknown() }, { open: true })
).check;

const ModeSpecSchema = obj(
  {
    modelId: opt(str()),
    provider: opt(str()),
    thinkingLevel: opt(str()),
  },
  { open: true }
);

const isModeSpec = compile(ModeSpecSchema).check;

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

    return isManifest(manifest) && manifest.name === PACKAGE_NAME;
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

  if (
    !isFactoryModule(module) ||
    !isFunction<ExtensionFactory>(module.default)
  ) {
    throw new TypeError(`${file} has no default extension factory.`);
  }

  return module.default;
};

// amplike's handoff and subagent read -mode through this helper, so the T3
// replacements read it the same way.
export const loadModeSpecFrom = async (root: string): Promise<LoadModeSpec> => {
  const file = path.join(root, "extensions", "lib", "mode-utils.ts");
  const module: unknown = await import(file);

  if (!isModeUtils(module) || !isFunction<LoadModeSpec>(module.loadModeSpec)) {
    throw new TypeError(`${file} has no loadModeSpec export.`);
  }

  const { loadModeSpec } = module;

  return async (cwd, name) => {
    const spec: unknown = await loadModeSpec(cwd, name);

    return isModeSpec(spec) ? spec : undefined;
  };
};
