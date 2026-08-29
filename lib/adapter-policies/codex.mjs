import { canonicalizePath, isProtectedPath, protectedPaths } from "../execution-policy.mjs";

/**
 * OpenAI Codex's native policy compiler. Pure output lets the adapter integration own process
 * startup while keeping Astra's unattended restrictions explicit and reviewable.
 */

export const CODEX_POLICY_VERSION = 1;
export const CODEX_PERMISSION_PROFILE = "workspace-write";

export const CODEX_FORBIDDEN_EXEC_RULES = Object.freeze([
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
  "su",
  "curl",
  "wget",
  "ssh",
  "scp",
  "nc",
]);

const CODEX_DISABLED_FEATURES = Object.freeze([
  "multi_agent",
  "multi_agent_v2",
  "web_search",
  "browser",
  "apps",
  "mcp",
]);

/** Check the installed Codex capability report before launch. Unknown controls fail closed. */
export function probeCodexCapabilities({ version, knownVersions, supportedVersions, permissionProfiles, permissionProfile, approvalPolicies, supportsApprovalNever, supportsExecpolicyForbidden, execpolicy, features, featureIds } = {}) {
  knownVersions ??= supportedVersions;
  permissionProfiles ??= permissionProfile ? [permissionProfile] : permissionProfiles;
  permissionProfiles = Array.isArray(permissionProfiles)
    ? permissionProfiles.map((profile) => typeof profile === "string" ? profile : profile?.name)
    : permissionProfiles;
  approvalPolicies ??= supportsApprovalNever ? ["never"] : approvalPolicies;
  supportsExecpolicyForbidden ??= Boolean(execpolicy?.forbidden);
  features ??= featureIds;
  features = Array.isArray(features)
    ? features
    : features && typeof features === "object"
      ? Object.entries(features).filter(([, supported]) => supported === true).map(([feature]) => feature)
      : features;
  const reasons = [];
  if (typeof version !== "string" || !version.trim()) reasons.push("missing Codex version");
  if (!Array.isArray(knownVersions) || knownVersions.length === 0) reasons.push("missing known Codex versions");
  else if (!knownVersions.includes(version)) reasons.push(`unknown Codex version ${String(version)}`);
  if (!Array.isArray(permissionProfiles) || !permissionProfiles.includes(CODEX_PERMISSION_PROFILE)) {
    reasons.push(`unsupported Codex permission profile ${CODEX_PERMISSION_PROFILE}`);
  }
  if (!Array.isArray(approvalPolicies) || !approvalPolicies.includes("never")) {
    reasons.push("Codex approval policy never is unavailable");
  }
  if (supportsExecpolicyForbidden !== true) reasons.push("Codex execpolicy forbidden rules unavailable");
  if (!Array.isArray(features)) reasons.push("missing Codex feature capability report");
  else {
    const missing = CODEX_DISABLED_FEATURES.filter((feature) => !features.includes(feature));
    if (missing.length) reasons.push(`missing Codex feature ID(s): ${missing.join(", ")}`);
  }
  return { ok: reasons.length === 0, adapter: "codex", version: version ?? null, reasons };
}

/** Compile shared Astra policy into Codex's strict config and execpolicy fragments. */
export function compileCodexPolicy(input = {}, maybeCapabilities, maybeConfigDir) {
  const policy = input?.policy ?? input;
  const capabilities = input?.policy ? input.capabilities : maybeCapabilities;
  const configDir = input?.policy ? input.configDir : maybeConfigDir;
  assertSharedPolicy(policy);
  const probe = probeCodexCapabilities(capabilities);
  if (!probe.ok) throw new Error(`Codex capability probe failed: ${probe.reasons.join("; ")}`);

  const features = Object.fromEntries(CODEX_DISABLED_FEATURES.map((feature) => [feature, false]));
  const config = {
    approval_policy: "never",
    sandbox_permissions: CODEX_PERMISSION_PROFILE,
    network_access: false,
    config_source: "astra-inline",
    ignore_user_config: true,
    ignore_project_config: true,
    features,
    filesystem: {
      read_paths: [...policy.readPaths],
      write_paths: [...policy.writePaths],
    },
  };
  return {
    version: CODEX_POLICY_VERSION,
    adapter: "codex",
    mode: "auto",
    cwd: policy.cwd,
    capabilities: { ...policy.capabilities },
    readPaths: [...policy.readPaths],
    writePaths: [...policy.writePaths],
    protectedPaths: [...policy.protectedPaths],
    launch: {
      command: "codex",
      args: ["exec", "--config", "approval_policy=never", "--config", `sandbox_permissions=${CODEX_PERMISSION_PROFILE}`],
      ...(configDir ? { configDir } : {}),
    },
    config,
    execpolicy: {
      forbidden: [...CODEX_FORBIDDEN_EXEC_RULES],
      rules: CODEX_FORBIDDEN_EXEC_RULES.map((command) => ({ command, action: "forbidden" })),
    },
    delegation: { multi_agent: false, multi_agent_v2: false },
    surfaces: { web: false, browser: false, apps: false, mcp: false },
    interaction: { approval: "never", onDenied: "fail" },
    probe,
  };
}

/** Alias for integrations that call adapter policy generation "compile". */
export const compile = compileCodexPolicy;

function assertSharedPolicy(policy) {
  if (!policy || policy.version !== 1 || policy.mode !== "auto" || typeof policy.cwd !== "string") {
    throw new TypeError("Codex policy requires shared auto execution policy");
  }
  if (!Array.isArray(policy.readPaths) || !Array.isArray(policy.writePaths) || !Array.isArray(policy.protectedPaths)) {
    throw new TypeError("Codex policy requires shared readPaths and writePaths");
  }
  if (!samePaths(policy.protectedPaths, protectedPaths(policy.cwd))) {
    throw new TypeError("Codex policy requires canonical Astra hard-protected paths");
  }
  if (policy.capabilities?.shell !== false || policy.capabilities?.network !== false || policy.capabilities?.delegation !== false) {
    throw new TypeError("Codex policy requires shell, network, and delegation denied");
  }
  for (const path of [...policy.readPaths, ...policy.writePaths]) {
    canonicalizePath(path, policy.cwd);
    if (isProtectedPath(path, policy.cwd)) throw new TypeError(`Codex policy scope is hard-protected: ${path}`);
  }
}

function samePaths(actual, expected) {
  return actual.length === expected.length
    && new Set(actual).size === expected.length
    && expected.every((path) => actual.includes(path));
}
