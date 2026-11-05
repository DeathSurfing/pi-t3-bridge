import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  findAmplike,
  loadFactory,
  loadModeSpecFrom,
} from "./src/amplike/package.ts";
import { t3View } from "./src/amplike/t3-view.ts";
import { insideT3 } from "./src/bridge/t3-http.ts";

// T3 asks the user before risky tool calls itself, so amplike's bash prompt
// would ask a second time.
const T3_SKIPPED_EXTENSIONS: ReadonlySet<string> = new Set(["permissions"]);

// Loads pi-amplike's extensions in place of Pi, so a T3 thread gets T3's
// versions of the parts T3 can't show. Outside T3 amplike loads unchanged.
// It runs only when the settings entry for amplike turns its extensions off.
const amplikeExtension = async (pi: ExtensionAPI): Promise<void> => {
  const amplike = await findAmplike(process.cwd());

  if (amplike === undefined) {
    return;
  }

  if (amplike.selfLoaded) {
    if (insideT3()) {
      pi.on("session_start", (_event, ctx) => {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `pi-t3 can't adapt pi-amplike for T3 while pi-amplike loads its own extensions. In ~/.pi/agent/settings.json, change "${amplike.source}" to {"source":"${amplike.source}","extensions":[]}.`,
            "warning"
          );
        }
      });
    }

    return;
  }

  const inT3 = insideT3();

  const host = inT3 ? t3View(pi, await loadModeSpecFrom(amplike.root)) : pi;

  const files = inT3
    ? amplike.extensions.filter(
        (file) => !T3_SKIPPED_EXTENSIONS.has(path.parse(file).name)
      )
    : amplike.extensions;

  const factories = await Promise.all(files.map(loadFactory));

  // Each call starts in file order, as when Pi loads the files itself.
  await Promise.all(factories.map((factory) => factory(host)));
};

export default amplikeExtension;
