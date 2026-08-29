import { canonicalizePath, isProtectedPath, protectedPaths } from "../execution-policy.mjs";

/**
 * Factory Droid's native policy compiler. This module is deliberately pure: the adapter owns
 * process launching, while this seam turns Astra's shared policy into hard launch/config inputs.
 */

export const DROID_POLICY_VERSION = 1;

const DROID_TOOL_SET = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "shell",
  "terminal",
  "bash",
  "command",
  "mission",
  "task",
  "delegate_task",
  "web",
  "browser",
  "mcp",
]);

export const DROID_ALLOWED_TOOL_IDS = Object.freeze(["read", "grep", "find", "ls", "edit", "write"]);
export const DROID_READ_TOOL_IDS = Object.freeze(["read", "grep", "find", "ls"]);
export const DROID_WRITE_TOOL_IDS = Object.freeze(["edit", "write"]);
export const DROID_DISABLED_TOOL_IDS = Object.freeze([
  "shell",
  "terminal",
  "bash",
  "command",
  "mission",
  "task",
  "delegate_task",
  "web",
  "browser",
  "mcp",
]);

export const DROID_HARD_COMMAND_BLOCKLIST = Object.freeze([
  "git push",
  "git rebase",
  "git reset",
  "git clean",
  "git commit",
  "git checkout",
  "git switch",
  "rm -rf",
  "rm -r",
  "sudo",
  "doas",
  "su ",
  "curl | sh",
  "curl | bash",
  "wget | sh",
  "wget | bash",
  "ssh",
  "scp",
  "nc ",
]);

/**
 * Check the installed Droid capability report before launch. `knownVersions` is supplied by the
 * version-specific adapter probe; an absent allowlist is intentionally not considered proof.
 */
export function probeDroidCapabilities({ version, knownVersions, supportedVersions, toolIds, tools, requiredToolIds = DROID_ALLOWED_TOOL_IDS } = {}) {
  knownVersions ??= supportedVersions;
  toolIds ??= tools;
  toolIds = Array.isArray(toolIds) ? toolIds.map((tool) => typeof tool === "string" ? tool : tool?.id) : toolIds;
  const reasons = [];
  if (typeof version !== "string" || !version.trim()) reasons.push("missing Droid version");
  if (!Array.isArray(knownVersions) || knownVersions.length === 0) reasons.push("missing known Droid versions");
  else if (!knownVersions.includes(version)) reasons.push(`unknown Droid version ${String(version)}`);
  if (!Array.isArray(toolIds) || toolIds.length === 0) reasons.push("missing Droid tool IDs");
  else {
    const unknown = toolIds.filter((id) => typeof id !== "string" || !DROID_TOOL_SET.has(id));
    if (unknown.length) reasons.push(`unknown Droid tool ID(s): ${unknown.join(", ")}`);
    const missing = requiredToolIds.filter((id) => !toolIds.includes(id));
    if (missing.length) reasons.push(`missing required Droid tool ID(s): ${missing.join(", ")}`);
  }
  return { ok: reasons.length === 0, adapter: "droid", version: version ?? null, reasons };
}

/** Compile shared Astra policy into Droid launch fragments and hard controls. */
export function compileDroidPolicy(input = {}, maybeCapabilities) {
  const policy = input?.policy ?? input;
  const capabilities = input?.policy ? input.capabilities : maybeCapabilities;
  assertSharedPolicy(policy);
  const requiredToolIds = policy.writePaths.length ? DROID_ALLOWED_TOOL_IDS : DROID_READ_TOOL_IDS;
  const probe = probeDroidCapabilities({ ...capabilities, requiredToolIds });
  if (!probe.ok) throw new Error(`Droid capability probe failed: ${probe.reasons.join("; ")}`);

  return {
    version: DROID_POLICY_VERSION,
    adapter: "droid",
    mode: "auto",
    cwd: policy.cwd,
    capabilities: { ...policy.capabilities },
    readPaths: [...policy.readPaths],
    writePaths: [...policy.writePaths],
    protectedPaths: [...policy.protectedPaths],
    launch: {
      command: "droid",
      args: ["exec", "--restrict-tools", requiredToolIds.join(",")],
    },
    tools: {
      allowed: [...requiredToolIds],
      disabled: [...DROID_DISABLED_TOOL_IDS],
    },
    commandBlocklist: [...DROID_HARD_COMMAND_BLOCKLIST],
    sandbox: {
      filesystem: {
        read: [...policy.readPaths],
        write: [...policy.writePaths],
      },
      network: { enabled: false, allow: [] },
    },
    delegation: { mission: false, task: false },
    interaction: { approval: "never", onDenied: "fail" },
    probe,
  };
}

/** Alias for integrations that call adapter policy generation "compile". */
export const compile = compileDroidPolicy;

function assertSharedPolicy(policy) {
  if (!policy || policy.version !== 1 || policy.mode !== "auto" || typeof policy.cwd !== "string") {
    throw new TypeError("Droid policy requires shared auto execution policy");
  }
  if (!Array.isArray(policy.readPaths) || !Array.isArray(policy.writePaths) || !Array.isArray(policy.protectedPaths)) {
    throw new TypeError("Droid policy requires shared readPaths and writePaths");
  }
  if (!samePaths(policy.protectedPaths, protectedPaths(policy.cwd))) {
    throw new TypeError("Droid policy requires canonical Astra hard-protected paths");
  }
  if (policy.capabilities?.shell !== false || policy.capabilities?.network !== false || policy.capabilities?.delegation !== false) {
    throw new TypeError("Droid policy requires shell, network, and delegation denied");
  }
  for (const path of [...policy.readPaths, ...policy.writePaths]) {
    canonicalizePath(path, policy.cwd);
    if (isProtectedPath(path, policy.cwd)) throw new TypeError(`Droid policy scope is hard-protected: ${path}`);
  }
}

function samePaths(actual, expected) {
  return actual.length === expected.length
    && new Set(actual).size === expected.length
    && expected.every((path) => actual.includes(path));
}
