import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  env: core.env,
  extends: [core, antiSlop],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    "artifacts/**",
    "pstack/**",
    "tstack/**",
  ],
  rules: {
    // Pi types every command handler as returning a Promise.
    "eslint/require-await": "off",
  },
});
