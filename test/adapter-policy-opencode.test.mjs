import { test } from "node:test";
import assert from "node:assert/strict";

import { compileOpenCodePolicy, probeOpenCodeCapabilities } from "../lib/adapter-policies/opencode.mjs";
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

const baseCapabilities = {
  version: "1.2.3",
  knownVersions: ["1.2.3"],
  schema: "v1",
  supportedSchemas: ["v1", "v2"],
};

test("OpenCode V1 compiler injects final scoped permissions with no ask rules", () => {
  const result = compileOpenCodePolicy({ policy, capabilities: baseCapabilities });

  assert.equal(result.adapter, "opencode");
  assert.equal(result.schema, "v1");
  assert.equal(result.outerSandboxRequired, true);
  assert.equal(result.failUnknown, true);
  assert.equal(result.config.permission.bash, "deny");
  assert.equal(result.config.permission.webfetch, "deny");
  assert.equal(result.config.permission.mcp, "deny");
  assert.equal(result.config.permission.skill, "deny");
  assert.equal(result.config.permission.external_directory, "deny");
  assert.equal(result.config.permission.task, "deny");
  assert.equal(result.config.permission.edit["/workspace/project/src/widget.mjs"], "allow");
  assert.equal(result.config.permission.edit["/workspace/project/.git"], "deny");
  assert.equal(result.config.permission.edit["/workspace/project/.git/**"], "deny");
  assert.equal(Object.prototype.hasOwnProperty.call(result.config.permission, "ask"), false);
});

test("OpenCode V2 compiler selects the detected schema and keeps controls explicit", () => {
  const result = compileOpenCodePolicy({
    policy,
    capabilities: { ...baseCapabilities, schema: "v2" },
  });

  assert.equal(result.schema, "v2");
  assert.ok(result.config.permissions);
  assert.equal(result.config.permissions.edit["/workspace/project/src/widget.mjs"], "allow");
  assert.equal(result.config.tools.shell, false);
  assert.equal(result.config.tools.web, false);
  assert.equal(result.config.tools.mcp, false);
  assert.equal(result.config.tools.skills, false);
  assert.equal(result.config.tools.subagents, false);
});

test("OpenCode capability probe fails closed for unknown versions and schemas", () => {
  assert.equal(probeOpenCodeCapabilities(baseCapabilities).ok, true);
  assert.equal(probeOpenCodeCapabilities({ ...baseCapabilities, version: "9.9.9" }).ok, false);
  assert.equal(probeOpenCodeCapabilities({ ...baseCapabilities, schema: "v3" }).ok, false);
  assert.equal(probeOpenCodeCapabilities({ ...baseCapabilities, supportedSchemas: ["v1"] , schema: "v2" }).ok, false);
  assert.throws(
    () => compileOpenCodePolicy({ policy, capabilities: { ...baseCapabilities, version: "9.9.9" } }),
    /OpenCode capability probe failed/,
  );
});

test("OpenCode compiler fails closed when shared capability denials are widened", () => {
  assert.throws(
    () => compileOpenCodePolicy({ policy: { ...policy, capabilities: { ...policy.capabilities, shell: true } }, capabilities: baseCapabilities }),
    /requires shell, network, and delegation denied/,
  );
});

test("OpenCode compiler rejects protected read and write scopes", () => {
  for (const target of [".git/config", ".env", ".claude/settings.json", ".codex/config.toml", ".agents/agent.md", "credentials.json", ".mcp.json"]) {
    assert.throws(() => compileOpenCodePolicy({ policy: { ...policy, readPaths: [`/workspace/project/${target}`] }, capabilities: baseCapabilities }), /hard-protected|protected/i, target);
    assert.throws(() => compileOpenCodePolicy({ policy: { ...policy, writePaths: [`/workspace/project/${target}`] }, capabilities: baseCapabilities }), /hard-protected|protected/i, target);
  }
  assert.throws(() => compileOpenCodePolicy({ policy: { ...policy, protectedPaths: protectedPaths(policy.cwd).slice(1) }, capabilities: baseCapabilities }), /protected/i);
});
