// Writes the provider request Pi is about to send to REQUEST_PROBE_OUT, then
// fails it, so a test reads the real request without calling a model.
import { writeFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function requestProbe(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event) => {
    writeFileSync(
      process.env.REQUEST_PROBE_OUT ?? "",
      JSON.stringify(event.payload)
    );

    throw new Error("request probe stops here");
  });
}
