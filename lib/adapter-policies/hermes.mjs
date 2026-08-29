import { canonicalizePath, isProtectedPath, protectedPaths } from "../execution-policy.mjs";

export const HERMES_POLICY_VERSION = 1;
export const HERMES_READ_TOOL_IDS = Object.freeze(["read", "grep", "find", "ls"]);
export const HERMES_WRITE_TOOL_IDS = Object.freeze(["edit", "write"]);
export const HERMES_DISABLED_TOOL_IDS = Object.freeze([
  "terminal",
  "shell",
  "bash",
  "code",
  "browser",
  "web",
  "web_search",
  "mcp",
  "task",
  "subagent",
  "delegate",
]);

const KNOWN_TOOL_IDS = new Set([...HERMES_READ_TOOL_IDS, ...HERMES_WRITE_TOOL_IDS, ...HERMES_DISABLED_TOOL_IDS]);

/** Probe Hermes capabilities without starting a local terminal or agent process. */
export function probeHermesCapabilities({ version, knownVersions, supportedVersions, toolIds, tools, isolatedBackendAvailable, supportsIsolatedBackend, requireIsolatedBackend = false, requireWrites = false } = {}) {
  knownVersions ??= supportedVersions;
  toolIds ??= tools;
  isolatedBackendAvailable ??= supportsIsolatedBackend;
  const reasons = [];
  if (typeof version !== "string" || !version.trim()) reasons.push("missing Hermes version");
  if (!Array.isArray(knownVersions) || knownVersions.length === 0) reasons.push("missing known Hermes versions");
  else if (!knownVersions.includes(version)) reasons.push(`unknown Hermes version ${String(version)}`);
  if (!Array.isArray(toolIds) || toolIds.length === 0) reasons.push("missing Hermes tool IDs");
  else {
    const unknown = toolIds.filter((id) => typeof id !== "string" || !KNOWN_TOOL_IDS.has(id));
    if (unknown.length) reasons.push(`unknown Hermes tool ID(s): ${unknown.join(", ")}`);
    const required = requireWrites ? [...HERMES_READ_TOOL_IDS, ...HERMES_WRITE_TOOL_IDS] : HERMES_READ_TOOL_IDS;
    const missing = required.filter((id) => !toolIds.includes(id));
    if (missing.length) reasons.push(`missing required Hermes tool ID(s): ${missing.join(", ")}`);
  }
  if ((requireIsolatedBackend || requireWrites) && isolatedBackendAvailable !== true) {
    reasons.push("Hermes isolated backend is unavailable for file writes");
  }
  return { ok: reasons.length === 0, adapter: "hermes", version: version ?? null, reasons };
}

/** Compile shared Astra policy into a curated Hermes toolset and honest sandbox requirement. */
export function compileHermesPolicy(input = {}, maybeCapabilities) {
  const policy = input?.policy ?? input;
  const capabilities = input?.policy ? input.capabilities : maybeCapabilities;
  assertSharedPolicy(policy);
  const needsWrites = policy.writePaths.length > 0;
  const probe = probeHermesCapabilities({ ...capabilities, requireWrites: needsWrites });
  if (!probe.ok) throw new Error(`Hermes capability probe failed: ${probe.reasons.join("; ")}`);
  const allowed = needsWrites ? [...HERMES_READ_TOOL_IDS, ...HERMES_WRITE_TOOL_IDS] : [...HERMES_READ_TOOL_IDS];

  return {
    version: HERMES_POLICY_VERSION,
    adapter: "hermes",
    mode: "auto",
    launch: { command: "hermes", args: ["chat", "--non-interactive"] },
    tools: { allowed, denied: [...HERMES_DISABLED_TOOL_IDS] },
    sandbox: {
      required: needsWrites,
      backend: needsWrites ? "isolated" : null,
      allowUnsandboxed: false,
      filesystem: { read: [...policy.readPaths], write: [...policy.writePaths] },
      network: { enabled: false, allow: [] },
    },
    localTerminal: false,
    network: false,
    delegation: false,
    browser: false,
    web: false,
    mcp: false,
    interaction: { approval: "never", onDenied: "fail" },
    probe,
  };
}

export const compile = compileHermesPolicy;

function assertSharedPolicy(policy) {
  if (!policy || policy.version !== 1 || policy.mode !== "auto" || typeof policy.cwd !== "string") {
    throw new TypeError("Hermes policy requires shared auto execution policy");
  }
  if (!Array.isArray(policy.readPaths) || !Array.isArray(policy.writePaths) || !Array.isArray(policy.protectedPaths)) {
    throw new TypeError("Hermes policy requires shared readPaths and writePaths");
  }
  if (!samePaths(policy.protectedPaths, protectedPaths(policy.cwd))) {
    throw new TypeError("Hermes policy requires canonical Astra hard-protected paths");
  }
  if (policy.capabilities?.shell !== false || policy.capabilities?.network !== false || policy.capabilities?.delegation !== false) {
    throw new TypeError("Hermes policy requires shell, network, and delegation denied");
  }
  for (const path of [...policy.readPaths, ...policy.writePaths]) {
    canonicalizePath(path, policy.cwd);
    if (isProtectedPath(path, policy.cwd)) throw new TypeError(`Hermes policy scope is hard-protected: ${path}`);
  }
}

function samePaths(actual, expected) {
  return actual.length === expected.length
    && new Set(actual).size === expected.length
    && expected.every((path) => actual.includes(path));
}
