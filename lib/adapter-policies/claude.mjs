import { canonicalizePath, isProtectedPath, protectedPaths } from "../execution-policy.mjs";

const HARD_DENIED_TOOLS = Object.freeze([
  "Bash",
  "WebFetch",
  "WebSearch",
  "Task",
  "TaskOutput",
  "Agent",
  "mcp__*",
]);

/**
 * Compile the shared policy into an Astra-owned Claude Code settings fragment. The fragment is
 * deliberately data-only so the caller can write it to an isolated settings file.
 */
export function compileClaudePolicy(policy) {
  assertPolicy(policy);
  const allow = [
    ...policy.readPaths.map((path) => `Read(${scopePath(path, policy.cwd)})`),
    ...policy.writePaths.flatMap((path) => [`Edit(${scopePath(path, policy.cwd)})`, `Write(${scopePath(path, policy.cwd)})`]),
  ];
  const protectedRules = policy.protectedPaths.flatMap((path) => {
    const scoped = scopePath(path, policy.cwd);
    const scopes = [scoped, scoped.endsWith("/**") ? scoped : `${scoped}/**`];
    return scopes.flatMap((value) => [`Read(${value})`, `Edit(${value})`, `Write(${value})`]);
  });
  const deny = [...HARD_DENIED_TOOLS, ...protectedRules];

  return {
    version: policy.version,
    adapter: "claude",
    cwd: policy.cwd,
    settingsOwner: "astra",
    settings: {
      permissions: {
        defaultMode: "dontAsk",
        allow,
        deny,
        ask: [],
      },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: false,
        network: { allowedDomains: [] },
      },
    },
    disallowedTools: [...HARD_DENIED_TOOLS],
    hooks: {
      PreToolUse: {
        owner: "astra",
        matcher: "*",
        action: "enforce",
        policyVersion: policy.version,
      },
    },
    capabilities: { ...policy.capabilities },
    readPaths: [...policy.readPaths],
    writePaths: [...policy.writePaths],
    protectedPaths: [...policy.protectedPaths],
  };
}

export const compileClaudeAutoPolicy = compileClaudePolicy;

function assertPolicy(policy) {
  if (!policy || policy.version !== 1 || policy.mode !== "auto" || typeof policy.cwd !== "string") {
    throw new TypeError("invalid execution policy for Claude");
  }
  if (!Array.isArray(policy.readPaths) || !Array.isArray(policy.writePaths) || !Array.isArray(policy.protectedPaths)) {
    throw new TypeError("invalid path scopes for Claude");
  }
  const requiredProtected = protectedPaths(policy.cwd);
  if (!samePaths(policy.protectedPaths, requiredProtected)) {
    throw new Error("Claude policy is missing Astra hard-protected paths");
  }
  if (policy.capabilities?.shell !== false || policy.capabilities?.network !== false || policy.capabilities?.delegation !== false) {
    throw new Error("Claude policy must fail closed when shell, network, or delegation is enabled");
  }
  for (const path of [...policy.readPaths, ...policy.writePaths]) {
    canonicalizePath(path, policy.cwd);
    if (isProtectedPath(path, policy.cwd)) throw new Error(`Claude policy scope is hard-protected: ${path}`);
  }
}

function scopePath(path, cwd) {
  return path === cwd ? `${path}/**` : path;
}

function samePaths(actual, expected) {
  return actual.length === expected.length
    && new Set(actual).size === expected.length
    && expected.every((path) => actual.includes(path));
}
