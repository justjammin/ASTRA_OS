import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compileCodexPolicy,
  probeCodexCapabilities,
} from "../lib/adapter-policies/codex.mjs";
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
  version: "0.1.0",
  knownVersions: ["0.1.0"],
  permissionProfiles: ["workspace-write"],
  approvalPolicies: ["never"],
  supportsExecpolicyForbidden: true,
  features: ["multi_agent", "multi_agent_v2", "web_search", "browser", "apps", "mcp"],
};

test("Codex compiler emits isolated strict auto-mode controls", () => {
  const result = compileCodexPolicy({ policy, capabilities, configDir: "/tmp/astra-codex" });

  assert.equal(result.adapter, "codex");
  assert.equal(result.config.approval_policy, "never");
  assert.equal(result.config.sandbox_permissions, "workspace-write");
  assert.equal(result.config.network_access, false);
  assert.deepEqual(result.config.features, {
    multi_agent: false,
    multi_agent_v2: false,
    web_search: false,
    browser: false,
    apps: false,
    mcp: false,
  });
  assert.ok(result.execpolicy.forbidden.some((rule) => /git push/.test(rule))); 
  assert.ok(result.execpolicy.forbidden.some((rule) => /rm -rf/.test(rule)));
  assert.equal(result.launch.configDir, "/tmp/astra-codex");
  assert.ok(result.launch.args.includes("--config"));
});

test("Codex capability probe fails closed when restricted permission behavior is unknown", () => {
  assert.equal(probeCodexCapabilities(capabilities).ok, true);
  assert.equal(probeCodexCapabilities({ ...capabilities, permissionProfiles: ["danger-full-access"] }).ok, false);
  assert.equal(probeCodexCapabilities({ ...capabilities, supportsExecpolicyForbidden: false }).ok, false);
  assert.throws(
    () => compileCodexPolicy({ policy, capabilities: { ...capabilities, permissionProfiles: [] } }),
    /Codex capability probe failed/,
  );
});

test("Codex compiler rejects protected read and write scopes", () => {
  for (const target of [".git/config", ".env", ".claude/settings.json", ".codex/config.toml", ".agents/agent.md", "credentials.json", ".mcp.json"]) {
    assert.throws(() => compileCodexPolicy({ policy: { ...policy, readPaths: [`/workspace/project/${target}`] }, capabilities }), /hard-protected|protected/i, target);
    assert.throws(() => compileCodexPolicy({ policy: { ...policy, writePaths: [`/workspace/project/${target}`] }, capabilities }), /hard-protected|protected/i, target);
  }
  assert.throws(() => compileCodexPolicy({ policy: { ...policy, protectedPaths: protectedPaths(policy.cwd).slice(1) }, capabilities }), /protected/i);
});
