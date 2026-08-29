import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveDagWorkerPolicy, deriveScoutPolicy, protectedPaths } from "../lib/execution-policy.mjs";
import { compilePiPolicy, guardPiToolCall } from "../lib/adapter-policies/pi.mjs";

const cwd = "/workspace/project";

test("Pi scout compiler emits an explicit read-only tool surface", () => {
  const policy = compilePiPolicy(deriveScoutPolicy({ cwd }));

  assert.deepEqual(policy.tools, ["read", "grep", "find", "ls"]);
  assert.equal(policy.noExtensions, true);
  assert.deepEqual(policy.excludeTools, ["bash"]);
  assert.equal(policy.capabilities.shell, false);
  assert.equal(policy.capabilities.network, false);
  assert.equal(policy.capabilities.delegation, false);
  assert.equal(JSON.parse(JSON.stringify(policy)).noExtensions, true);
});

test("Pi worker compiler enables only scoped file mutation tools", () => {
  const policy = compilePiPolicy(deriveDagWorkerPolicy({ cwd, role: { writeBoundary: ["src/widget.mjs"] } }));

  assert.deepEqual(policy.tools, ["read", "grep", "find", "ls", "write", "edit"]);
  assert.deepEqual(policy.writePaths, [join(cwd, "src/widget.mjs")]);
  assert.equal(policy.extensionDiscovery, false);
  assert.equal(policy.allowDelegation, false);
  assert.equal(policy.allowNetwork, false);
});

test("Pi tool-call guard blocks bash, delegation, unknown tools, and path escapes", async () => {
  const policy = deriveDagWorkerPolicy({ cwd, role: { writeBoundary: ["src/widget.mjs"] } });
  const blocked = [
    [{ toolName: "bash", input: { command: "echo nope" } }, /bash/],
    [{ toolName: "task", input: { prompt: "spawn" } }, /tool/],
    [{ toolName: "custom_tool", input: {} }, /tool/],
    [{ toolName: "write", input: { path: "../outside.txt", content: "nope" } }, /outside|scope/],
    [{ toolName: "read", input: { path: ".git/config" } }, /protected/],
  ];
  for (const [event, reason] of blocked) {
    const result = await guardPiToolCall(policy, event);
    assert.equal(result.block, true);
    assert.match(result.reason, reason);
  }
  assert.equal(await guardPiToolCall(policy, { toolName: "write", input: { path: "src/widget.mjs" } }), undefined);
});

test("Pi tool-call guard resolves symlink escapes before allowing writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "astra-pi-policy-"));
  const outside = await mkdtemp(join(tmpdir(), "astra-pi-outside-"));
  await mkdir(join(root, "src"));
  await symlink(outside, join(root, "src", "linked"));
  const policy = deriveDagWorkerPolicy({ cwd: root, role: { writeBoundary: ["src/**"] } });

  const result = await guardPiToolCall(policy, { toolName: "write", input: { path: "src/linked/escape.mjs" } });
  assert.equal(result.block, true);
  assert.match(result.reason, /outside|scope|symlink/i);
});

test("Pi compiler fails closed if a caller widens execution capabilities", () => {
  const policy = { ...deriveScoutPolicy({ cwd }), capabilities: { shell: true, network: false, delegation: false } };
  assert.throws(() => compilePiPolicy(policy), /capabilit|fail closed/i);
  assert.throws(() => compilePiPolicy({ ...deriveScoutPolicy({ cwd }), protectedPaths: [] }), /protected/i);
});

test("Pi compiler rejects protected read and write scopes", () => {
  const base = deriveScoutPolicy({ cwd });
  for (const target of [".git/config", ".env", ".claude/settings.json", ".codex/config.toml", ".agents/agent.md", "credentials.json", ".mcp.json"]) {
    assert.throws(() => compilePiPolicy({ ...base, readPaths: [join(cwd, target)] }), /hard-protected|protected/i, target);
    assert.throws(() => compilePiPolicy({ ...base, writePaths: [join(cwd, target)] }), /hard-protected|protected/i, target);
  }
  assert.throws(() => compilePiPolicy({ ...base, protectedPaths: protectedPaths(cwd).slice(1) }), /protected/i);
});
