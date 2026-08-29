import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compileDroidPolicy,
  probeDroidCapabilities,
} from "../lib/adapter-policies/droid.mjs";
import { protectedPaths } from "../lib/execution-policy.mjs";

const policy = {
  version: 1,
  mode: "auto",
  cwd: "/workspace/project",
  readPaths: ["/workspace/project"],
  writePaths: ["/workspace/project/src"],
  protectedPaths: protectedPaths("/workspace/project"),
  capabilities: { shell: false, network: false, delegation: false },
};

const capabilities = {
  version: "1.2.3",
  knownVersions: ["1.2.3"],
  toolIds: ["read", "grep", "find", "ls", "edit", "write", "shell", "terminal", "mission", "task"],
};

test("Droid compiler emits restricted tools, hard blocks, and a default-deny sandbox", () => {
  const result = compileDroidPolicy({ policy, capabilities });

  assert.equal(result.adapter, "droid");
  assert.deepEqual(result.launch.args.slice(0, 2), ["exec", "--restrict-tools"]);
  assert.deepEqual(result.tools.allowed, ["read", "grep", "find", "ls", "edit", "write"]);
  assert.ok(result.tools.disabled.includes("mission"));
  assert.ok(result.tools.disabled.includes("task"));
  assert.ok(result.commandBlocklist.some((rule) => /git push/.test(rule)));
  assert.ok(result.commandBlocklist.some((rule) => /sudo/.test(rule)));
  assert.deepEqual(result.sandbox.filesystem.read, policy.readPaths);
  assert.deepEqual(result.sandbox.filesystem.write, policy.writePaths);
  assert.deepEqual(result.sandbox.network, { enabled: false, allow: [] });
  assert.equal(result.interaction.approval, "never");
});

test("Droid capability probe fails closed for unknown versions and missing tool IDs", () => {
  assert.equal(probeDroidCapabilities(capabilities).ok, true);
  assert.equal(probeDroidCapabilities({ ...capabilities, version: "9.9.9" }).ok, false);
  assert.equal(probeDroidCapabilities({ ...capabilities, toolIds: ["read"] }).ok, false);
  assert.throws(
    () => compileDroidPolicy({ policy, capabilities: { ...capabilities, version: "9.9.9" } }),
    /Droid capability probe failed/,
  );
});

test("Droid read-only policy does not advertise write tools", () => {
  const readOnly = { ...policy, writePaths: [] };
  const result = compileDroidPolicy({ policy: readOnly, capabilities });

  assert.deepEqual(result.tools.allowed, ["read", "grep", "find", "ls"]);
  assert.equal(result.launch.args[2], "read,grep,find,ls");
});

test("Droid compiler rejects protected read and write scopes", () => {
  for (const target of [".git/config", ".env", ".claude/settings.json", ".codex/config.toml", ".agents/agent.md", "credentials.json", ".mcp.json"]) {
    assert.throws(() => compileDroidPolicy({ policy: { ...policy, readPaths: [`/workspace/project/${target}`] }, capabilities }), /hard-protected|protected/i, target);
    assert.throws(() => compileDroidPolicy({ policy: { ...policy, writePaths: [`/workspace/project/${target}`] }, capabilities }), /hard-protected|protected/i, target);
  }
  assert.throws(() => compileDroidPolicy({ policy: { ...policy, protectedPaths: protectedPaths(policy.cwd).slice(1) }, capabilities }), /protected/i);
});
