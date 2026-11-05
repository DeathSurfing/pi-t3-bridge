import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerAccounts } from "./src/bridge/accounts.ts";
import { registerAsk } from "./src/bridge/ask.ts";
import { registerBashTimeout } from "./src/bridge/bash-timeout.ts";
import { registerUnlessTaken } from "./src/bridge/claim.ts";
import { registerConfig } from "./src/bridge/config.ts";
import { registerPlanGate } from "./src/bridge/plan.ts";
import { registerResume } from "./src/bridge/resume.ts";
import { registerSkills } from "./src/bridge/skills.ts";
import { moveOldState } from "./src/bridge/state.ts";
import { registerSteer } from "./src/bridge/steer.ts";
import { registerT3Mcp } from "./src/bridge/t3-mcp.ts";
import { tasksTool } from "./src/bridge/tasks.ts";
import { registerTranscript } from "./src/bridge/transcript.ts";
import { registerUsage } from "./src/bridge/usage.ts";

// The Pi to T3 bridge. It imports only src/bridge and npm packages, so it runs
// on its own when the other extension in this package is turned off.
const piT3Bridge = (pi: ExtensionAPI): void => {
  moveOldState();
  registerConfig(pi);
  registerTranscript(pi);
  registerUnlessTaken(pi, tasksTool);
  registerBashTimeout(pi);
  registerAccounts(pi);
  registerResume(pi);
  registerSkills(pi);
  registerPlanGate(pi);
  registerAsk(pi);
  registerT3Mcp(pi);
  registerUsage(pi);
  registerSteer(pi);
};

export default piT3Bridge;
