import { canonicalizePath, isProtectedPath, protectedPaths } from "../execution-policy.mjs";

export const OPENCODE_POLICY_VERSION = 1;
export const OPENCODE_SUPPORTED_SCHEMAS = Object.freeze(["v1", "v2"]);
export const OPENCODE_DENIED_TOOLS = Object.freeze([
  "bash",
  "webfetch",
  "websearch",
  "mcp",
  "skill",
  "external_directory",
  "task",
  "subagent",
]);

/** Probe the installed OpenCode version and select exactly one supported permission schema. */
export function probeOpenCodeCapabilities({ version, knownVersions, supportedVersions, schema, schemaVersion, permissionSchema, supportedSchemas } = {}) {
  knownVersions ??= supportedVersions;
  schema = normalizeSchema(schema ?? schemaVersion ?? permissionSchema);
  supportedSchemas = Array.isArray(supportedSchemas)
    ? supportedSchemas.map(normalizeSchema)
    : [...OPENCODE_SUPPORTED_SCHEMAS];
  const reasons = [];
  if (typeof version !== "string" || !version.trim()) reasons.push("missing OpenCode version");
  if (!Array.isArray(knownVersions) || knownVersions.length === 0) reasons.push("missing known OpenCode versions");
  else if (!knownVersions.includes(version)) reasons.push(`unknown OpenCode version ${String(version)}`);
  if (!schema) reasons.push("missing or ambiguous OpenCode permission schema");
  else if (!OPENCODE_SUPPORTED_SCHEMAS.includes(schema) || !supportedSchemas.includes(schema)) {
    reasons.push(`unsupported OpenCode permission schema ${String(schema)}`);
  }
  return { ok: reasons.length === 0, adapter: "opencode", version: version ?? null, schema: schema ?? null, reasons };
}

/** Compile shared Astra policy into an isolated OpenCode config and outer-sandbox declaration. */
export function compileOpenCodePolicy(input = {}, maybeCapabilities, maybeConfigDir) {
  const policy = input?.policy ?? input;
  const capabilities = input?.policy ? input.capabilities : maybeCapabilities;
  const configDir = input?.policy ? input.configDir : maybeConfigDir;
  assertSharedPolicy(policy);
  const probe = probeOpenCodeCapabilities(capabilities ?? {});
  if (!probe.ok) throw new Error(`OpenCode capability probe failed: ${probe.reasons.join("; ")}`);

  const permission = buildPermission(policy);
  const config = probe.schema === "v1"
    ? {
      schemaVersion: "v1",
      configSource: "astra-inline",
      ignoreUserConfig: true,
      ignoreProjectConfig: true,
      permission,
      tools: disabledTools(),
    }
    : {
      schemaVersion: "v2",
      configSource: "astra-inline",
      ignoreUserConfig: true,
      ignoreProjectConfig: true,
      permissions: permission,
      permission,
      tools: disabledTools(),
    };
  return {
    version: OPENCODE_POLICY_VERSION,
    adapter: "opencode",
    mode: "auto",
    schema: probe.schema,
    launch: {
      command: "opencode",
      args: ["run", "--format", "json", "--config", "opencode-astra.json"],
      ...(configDir ? { configDir } : {}),
    },
    config,
    outerSandboxRequired: true,
    failUnknown: true,
    interaction: { approval: "never", onDenied: "fail" },
    surfaces: { shell: false, web: false, mcp: false, skills: false, externalDirectories: false, subagents: false },
    probe,
  };
}

export const compile = compileOpenCodePolicy;

function buildPermission(policy) {
  const read = scopedRules(policy.readPaths, policy.protectedPaths);
  const edit = scopedRules(policy.writePaths, policy.protectedPaths);
  return {
    read,
    edit,
    write: edit,
    bash: "deny",
    webfetch: "deny",
    websearch: "deny",
    mcp: "deny",
    skill: "deny",
    external_directory: "deny",
    task: "deny",
    subagent: "deny",
  };
}

function scopedRules(allowed, protectedPaths) {
  const rules = { "*": "deny" };
  for (const path of allowed) rules[path] = "allow";
  // Keep hard denies after grants so last-match implementations cannot let a broad read scope
  // or a forged ancestor grant override .git, credentials, or agent configuration protection.
  for (const path of protectedPaths) {
    rules[path] = "deny";
    rules[`${path}/**`] = "deny";
  }
  return rules;
}

function disabledTools() {
  return Object.fromEntries([
    ...OPENCODE_DENIED_TOOLS,
    "shell",
    "web",
    "skills",
    "subagents",
  ].map((tool) => [tool, false]));
}

function normalizeSchema(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return normalizeSchema(value.version ?? value.schemaVersion ?? value.id);
  }
  if (value === 1 || value === "1" || value === "v1" || value === "V1") return "v1";
  if (value === 2 || value === "2" || value === "v2" || value === "V2") return "v2";
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

function assertSharedPolicy(policy) {
  if (!policy || policy.version !== 1 || policy.mode !== "auto" || typeof policy.cwd !== "string") {
    throw new TypeError("OpenCode policy requires shared auto execution policy");
  }
  if (!Array.isArray(policy.readPaths) || !Array.isArray(policy.writePaths) || !Array.isArray(policy.protectedPaths)) {
    throw new TypeError("OpenCode policy requires shared readPaths and writePaths");
  }
  if (!samePaths(policy.protectedPaths, protectedPaths(policy.cwd))) {
    throw new TypeError("OpenCode policy requires canonical Astra hard-protected paths");
  }
  if (policy.capabilities?.shell !== false || policy.capabilities?.network !== false || policy.capabilities?.delegation !== false) {
    throw new TypeError("OpenCode policy requires shell, network, and delegation denied");
  }
  for (const path of [...policy.readPaths, ...policy.writePaths]) {
    canonicalizePath(path, policy.cwd);
    if (isProtectedPath(path, policy.cwd)) throw new TypeError(`OpenCode policy scope is hard-protected: ${path}`);
  }
}

function samePaths(actual, expected) {
  return actual.length === expected.length
    && new Set(actual).size === expected.length
    && expected.every((path) => actual.includes(path));
}
