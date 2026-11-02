import assert from "node:assert/strict";
import {
  glob,
  mkdtemp,
  cp,
  mkdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { piSdk } from "./harness.mjs";

const extensionDir = path.dirname(import.meta.dirname);

const expectedSkills = [
  "babysit-pr",
  "council",
  "file-pr",
  "full-send",
  "full-stop",
  "leaving-pr-comments",
  "modernize",
  "sol-loop",
  "takeover",
];

const loadSkills = async (root, extensionFiles) => {
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir, { recursive: true });

  const settingsManager = piSdk.SettingsManager.inMemory({
    compaction: { enabled: false },
  });

  const loader = new piSdk.DefaultResourceLoader({
    additionalExtensionPaths: extensionFiles.map((file) =>
      path.join(root, file)
    ),
    agentDir,
    cwd: root,
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager,
  });

  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);

  // Pi emits resources_discover when a session binds its extensions, so
  // the skill paths only land in the loader after a session exists.
  const { session } = await piSdk.createAgentSession({
    agentDir,
    cwd: root,
    resourceLoader: loader,
    sessionManager: piSdk.SessionManager.inMemory(root),
    settingsManager,
    tools: [],
  });

  try {
    await session.bindExtensions({ mode: "rpc" });

    return loader.getSkills();
  } finally {
    session.dispose();
  }
};

test("tstack skills are served alongside bridge and pstack", async () => {
  const { skills } = await loadSkills(extensionDir, [
    "bridge.ts",
    "tstack.ts",
    "pstack.ts",
  ]);

  const names = skills.map((skill) => skill.name);
  assert.equal(new Set(names).size, names.length, "skill names are unique");

  for (const name of expectedSkills) {
    assert.ok(names.includes(name), `${name} is served`);
  }

  assert.ok(names.includes("poteto-mode"), "pstack skills still served");
});

test("tstack skills are served without pstack", async () => {
  const { skills } = await loadSkills(extensionDir, ["bridge.ts", "tstack.ts"]);

  assert.deepEqual(
    skills.map((skill) => skill.name).toSorted(),
    expectedSkills
  );
});

// A copy with only tstack in it, so any import of src/bridge, src/pstack,
// bridge.ts or pstack.ts fails to load.
test("tstack.ts loads and serves its skills on its own", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-t3-tstack-alone-"));

  try {
    await cp(
      path.join(extensionDir, "tstack.ts"),
      path.join(root, "tstack.ts")
    );
    await cp(
      path.join(extensionDir, "package.json"),
      path.join(root, "package.json")
    );
    await cp(path.join(extensionDir, "tstack"), path.join(root, "tstack"), {
      recursive: true,
    });
    await symlink(
      path.join(extensionDir, "node_modules"),
      path.join(root, "node_modules")
    );

    const { skills } = await loadSkills(root, ["tstack.ts"]);

    assert.deepEqual(
      skills.map((skill) => skill.name).toSorted(),
      expectedSkills
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("vendored tstack matches the pinned upstream commit's skill set", async () => {
  const vendored = await Array.fromAsync(
    glob("tstack/skills/*/SKILL.md", { cwd: extensionDir })
  );

  assert.equal(vendored.length, expectedSkills.length);

  const { upstreams } = JSON.parse(
    await readFile(path.join(extensionDir, "package.json"), "utf-8")
  );

  assert.match(upstreams.tstack, /^[0-9a-f]{40}$/u);
});
