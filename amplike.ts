import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  findAmplike,
  loadFactory,
  loadModeSpecFrom,
} from "./src/amplike/package.ts";
import { t3View } from "./src/amplike/t3-view.ts";
import { insideT3 } from "./src/bridge/t3-http.ts";

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

  const host = insideT3()
    ? t3View(pi, await loadModeSpecFrom(amplike.root))
    : pi;

  const factories = await Promise.all(amplike.extensions.map(loadFactory));

  // Each call starts in file order, as when Pi loads the files itself.
  await Promise.all(factories.map((factory) => factory(host)));
};

export default amplikeExtension;
