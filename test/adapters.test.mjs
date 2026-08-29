import { test } from "node:test";
import assert from "node:assert/strict";

import { ADAPTER_IDS, getAdapter, invoke, mapPiTools } from "../lib/adapters.mjs";
import { deriveScoutPolicy } from "../lib/execution-policy.mjs";

test("Pi is a native SDK adapter", async () => {
  assert.ok(ADAPTER_IDS.includes("pi"));
  assert.equal(getAdapter("pi").sdk, true);

  const result = await invoke("pi", {
    prompt: "test",
    role: "worker",
    cwd: process.cwd(),
    workDir: process.cwd(),
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.argv, ["pi", "(native SDK)"]);
});

test("invoke compiles and returns the adapter policy in dry-run mode", async () => {
  const executionPolicy = deriveScoutPolicy({ cwd: process.cwd() });
  const result = await invoke("claude", {
    prompt: "test",
    role: "scout",
    cwd: process.cwd(),
    workDir: process.cwd(),
    executionPolicy,
    dryRun: true,
  });

  assert.equal(result.executionPolicy.profile, "scout");
  assert.equal(result.nativePolicy.adapter, "claude");
  assert.equal(result.nativePolicy.settings.permissions.defaultMode, "dontAsk");
});

test("external adapters use compiled launch fragments in dry-run output", async () => {
  const executionPolicy = deriveScoutPolicy({ cwd: process.cwd() });
  const opencode = await invoke("opencode", {
    prompt: "inspect",
    cwd: process.cwd(),
    workDir: process.cwd(),
    executionPolicy,
    adapterCapabilities: { version: "1.2.3", knownVersions: ["1.2.3"], schema: "v1" },
    dryRun: true,
  });
  assert.deepEqual(opencode.argv.slice(0, 3), ["opencode", "run", "--format"]);
  assert.ok(opencode.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(opencode.nativePolicy.outerSandboxRequired, true);

  const hermes = await invoke("hermes", {
    prompt: "inspect",
    cwd: process.cwd(),
    workDir: process.cwd(),
    executionPolicy,
    adapterCapabilities: {
      version: "1.0.0",
      knownVersions: ["1.0.0"],
      toolIds: ["read", "grep", "find", "ls"],
      isolatedBackendAvailable: false,
    },
    dryRun: true,
  });
  assert.deepEqual(hermes.argv.slice(0, 3), ["hermes", "chat", "--non-interactive"]);
});

test("OpenCode refuses an unsandboxed non-dry launch", async () => {
  const executionPolicy = deriveScoutPolicy({ cwd: process.cwd() });
  await assert.rejects(
    invoke("opencode", {
      prompt: "inspect",
      cwd: process.cwd(),
      workDir: process.cwd(),
      executionPolicy,
      policyCompiler: () => ({
        adapter: "opencode",
        launch: { command: "opencode", args: ["run", "--format", "json"] },
        outerSandboxRequired: true,
      }),
    }),
    /outer sandbox.*refusing unsandboxed launch/i,
  );
});

test("Pi tool mapping returns SDK tool objects, not only names", () => {
  const read = { name: "read", execute: async () => ({}) };
  const grep = { name: "grep", execute: async () => ({}) };
  const selected = mapPiTools(
    ["read", "grep"],
    "/workspace/project",
    () => [read, grep],
    () => [read, grep],
  );

  assert.deepEqual(selected, [read, grep]);
  assert.equal(typeof selected[0].execute, "function");
});
