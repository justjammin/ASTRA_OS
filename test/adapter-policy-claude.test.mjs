import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { deriveCoordinatorPolicy, deriveScoutPolicy, protectedPaths } from "../lib/execution-policy.mjs";
import { compileClaudePolicy } from "../lib/adapter-policies/claude.mjs";

const cwd = "/workspace/project";

test("Claude compiler creates an isolated dontAsk, fail-closed settings fragment", () => {
  const policy = compileClaudePolicy(deriveScoutPolicy({ cwd }));
  const settings = policy.settings;

  assert.equal(settings.permissions.defaultMode, "dontAsk");
  assert.deepEqual(settings.permissions.ask, []);
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.equal(settings.sandbox.autoAllowBashIfSandboxed, false);
  assert.equal(policy.settingsOwner, "astra");
  assert.equal(policy.capabilities.shell, false);
  assert.equal(policy.capabilities.network, false);
  assert.equal(policy.capabilities.delegation, false);
});

test("Claude compiler scopes allowed tools to policy paths and denies escape tools", () => {
  const policy = compileClaudePolicy(deriveCoordinatorPolicy({
    cwd,
    artifactPaths: [".astra/demo/PLAN.md"],
  }));
  const permissions = policy.settings.permissions;
  const allowed = permissions.allow.join("\n");
  const denied = permissions.deny;

  assert.ok(allowed.includes(`Read(${cwd}/**)`));
  assert.ok(allowed.includes(`Write(${join(cwd, ".astra/demo/PLAN.md")})`));
  assert.ok(allowed.includes(`Edit(${join(cwd, ".astra/demo/PLAN.md")})`));
  assert.ok(denied.includes("Bash"));
  assert.ok(denied.includes("WebFetch"));
  assert.ok(denied.includes("WebSearch"));
  assert.ok(denied.includes("Task"));
  assert.ok(denied.includes("mcp__*"));
  assert.deepEqual(policy.disallowedTools, ["Bash", "WebFetch", "WebSearch", "Task", "TaskOutput", "Agent", "mcp__*"]);
});

test("Claude policy carries an Astra-owned PreToolUse enforcement marker", () => {
  const policy = compileClaudePolicy(deriveScoutPolicy({ cwd }));
  const hook = policy.hooks.PreToolUse;

  assert.equal(hook.owner, "astra");
  assert.equal(hook.matcher, "*");
  assert.equal(hook.policyVersion, 1);
  assert.equal(hook.action, "enforce");
  assert.equal(JSON.parse(JSON.stringify(policy)).hooks.PreToolUse.owner, "astra");
});

test("Claude compiler rejects widened capabilities and missing sandbox requirements", () => {
  const base = deriveScoutPolicy({ cwd });
  assert.throws(() => compileClaudePolicy({ ...base, capabilities: { ...base.capabilities, network: true } }), /capabilit|fail closed/i);
  assert.throws(() => compileClaudePolicy({ ...base, protectedPaths: [] }), /protected/i);
});

test("Claude compiler rejects protected read and write scopes", () => {
  const base = deriveScoutPolicy({ cwd });
  for (const target of [".git/config", ".env", ".claude/settings.json", ".codex/config.toml", ".agents/agent.md", "credentials.json", ".mcp.json"]) {
    assert.throws(() => compileClaudePolicy({ ...base, readPaths: [join(cwd, target)] }), /hard-protected|protected/i, target);
    assert.throws(() => compileClaudePolicy({ ...base, writePaths: [join(cwd, target)] }), /hard-protected|protected/i, target);
  }
  assert.throws(() => compileClaudePolicy({ ...base, protectedPaths: protectedPaths(cwd).slice(1) }), /protected/i);
});
