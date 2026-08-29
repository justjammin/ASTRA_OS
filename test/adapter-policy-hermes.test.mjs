import { test } from "node:test";
import assert from "node:assert/strict";

import { compileHermesPolicy, probeHermesCapabilities } from "../lib/adapter-policies/hermes.mjs";
import { protectedPaths } from "../lib/execution-policy.mjs";

const policy = {
  version: 1,
  mode: "auto",
  cwd: "/workspace/project",
  readPaths: ["/workspace/project"],
  writePaths: ["/workspace/project/src/widget.mjs"],
  protectedPaths: protectedPaths("/workspace/project"),
  capabilities: { shell: false, network: false, delegation: false },
};

const capabilities = {
  version: "0.4.0",
  knownVersions: ["0.4.0"],
  toolIds: ["read", "grep", "find", "ls", "edit", "write", "terminal", "code", "browser", "web", "mcp"],
  isolatedBackendAvailable: true,
};

test("Hermes read/write compiler emits only curated tools and isolated backend requirements", () => {
  const result = compileHermesPolicy({ policy, capabilities });

  assert.equal(result.adapter, "hermes");
  assert.deepEqual(result.tools.allowed, ["read", "grep", "find", "ls", "edit", "write"]);
  assert.ok(result.tools.denied.includes("terminal"));
  assert.ok(result.tools.denied.includes("code"));
  assert.ok(result.tools.denied.includes("browser"));
  assert.ok(result.tools.denied.includes("web"));
  assert.ok(result.tools.denied.includes("mcp"));
  assert.equal(result.sandbox.required, true);
  assert.equal(result.sandbox.backend, "isolated");
  assert.equal(result.sandbox.allowUnsandboxed, false);
  assert.equal(result.localTerminal, false);
  assert.equal(result.network, false);
  assert.equal(result.delegation, false);
});

test("Hermes read-only profile does not require a write backend", () => {
  const readOnly = { ...policy, writePaths: [] };
  const result = compileHermesPolicy({ policy: readOnly, capabilities: { ...capabilities, isolatedBackendAvailable: false } });

  assert.deepEqual(result.tools.allowed, ["read", "grep", "find", "ls"]);
  assert.equal(result.sandbox.required, false);
  assert.equal(result.sandbox.backend, null);
});

test("Hermes refuses writes when isolated backend guarantees are unavailable", () => {
  assert.equal(probeHermesCapabilities({ ...capabilities, isolatedBackendAvailable: false, requireIsolatedBackend: true }).ok, false);
  assert.throws(
    () => compileHermesPolicy({ policy, capabilities: { ...capabilities, isolatedBackendAvailable: false } }),
    /Hermes capability probe failed|isolated backend/,
  );
});

test("Hermes capability probe fails closed for unknown versions", () => {
  assert.equal(probeHermesCapabilities(capabilities).ok, true);
  assert.equal(probeHermesCapabilities({ ...capabilities, version: "9.9.9" }).ok, false);
  assert.throws(
    () => compileHermesPolicy({ policy, capabilities: { ...capabilities, version: "9.9.9" } }),
    /Hermes capability probe failed/,
  );
});

test("Hermes compiler rejects protected read and write scopes", () => {
  for (const target of [".git/config", ".env", ".claude/settings.json", ".codex/config.toml", ".agents/agent.md", "credentials.json", ".mcp.json"]) {
    assert.throws(() => compileHermesPolicy({ policy: { ...policy, readPaths: [`/workspace/project/${target}`] }, capabilities }), /hard-protected|protected/i, target);
    assert.throws(() => compileHermesPolicy({ policy: { ...policy, writePaths: [`/workspace/project/${target}`] }, capabilities }), /hard-protected|protected/i, target);
  }
  assert.throws(() => compileHermesPolicy({ policy: { ...policy, protectedPaths: protectedPaths(policy.cwd).slice(1) }, capabilities }), /protected/i);
});
