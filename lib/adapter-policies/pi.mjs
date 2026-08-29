import { canonicalizePath, isPathAllowed, isProtectedPath, protectedPaths } from "../execution-policy.mjs";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const PI_READ_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
export const PI_WRITE_TOOLS = Object.freeze(["read", "grep", "find", "ls", "write", "edit"]);
export const PI_DISALLOWED_TOOLS = Object.freeze(["bash", "task", "agent", "subagent"]);

/**
 * Compile the shared execution policy into serializable options for createAgentSession().
 * Explicit tools and noExtensions are required because Pi otherwise discovers capabilities.
 */
export function compilePiPolicy(policy) {
  assertPolicy(policy);
  const tools = policy.writePaths.length ? [...PI_WRITE_TOOLS] : [...PI_READ_TOOLS];
  return {
    version: policy.version,
    adapter: "pi",
    cwd: policy.cwd,
    tools,
    excludeTools: ["bash"],
    disallowedTools: [...PI_DISALLOWED_TOOLS],
    noExtensions: true,
    extensionDiscovery: false,
    allowNetwork: false,
    allowDelegation: false,
    capabilities: { ...policy.capabilities },
    readPaths: [...policy.readPaths],
    writePaths: [...policy.writePaths],
    protectedPaths: [...policy.protectedPaths],
  };
}

/**
 * Return a Pi ExtensionAPI-compatible result. Allowed calls return undefined; blocked calls
 * return the SDK's `{ block, reason }` shape before a built-in tool executes.
 */
export async function guardPiToolCall(policy, event) {
  assertPolicy(policy);
  const toolName = event?.toolName;
  const input = event?.input ?? {};
  const allowedTools = policy.writePaths.length ? PI_WRITE_TOOLS : PI_READ_TOOLS;
  if (!allowedTools.includes(toolName)) return blocked(`tool ${String(toolName)} is not allowed by Astra policy`);

  const rawPath = input.path ?? input.file_path;
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return blocked(`${toolName} requires a path that Astra can validate`);
  }
  const operation = toolName === "write" || toolName === "edit" ? "write" : "read";
  let physicalPath;
  try {
    physicalPath = await resolvePhysicalPath(rawPath, policy.cwd);
  } catch {
    return blocked(`path is outside ${operation} scope: ${rawPath}`);
  }
  if (!physicalPath) return blocked(`unable to resolve path before ${operation}: ${rawPath}`);
  if (isPathAllowed(policy, physicalPath, operation)) return undefined;
  if (isProtectedPath(rawPath, policy.cwd)) return blocked(`path is protected by Astra policy: ${rawPath}`);
  return blocked(`path is outside ${operation} scope: ${rawPath}`);
}

export const checkPiToolCall = guardPiToolCall;

/** Factory for the callback accepted by pi.on("tool_call", handler). */
export function createPiToolCallGuard(policy) {
  assertPolicy(policy);
  return (event) => guardPiToolCall(policy, event);
}

function assertPolicy(policy) {
  if (!policy || policy.version !== 1 || policy.mode !== "auto" || typeof policy.cwd !== "string") {
    throw new TypeError("invalid execution policy for Pi");
  }
  if (!Array.isArray(policy.readPaths) || !Array.isArray(policy.writePaths) || !Array.isArray(policy.protectedPaths)) {
    throw new TypeError("invalid path scopes for Pi");
  }
  const requiredProtected = protectedPaths(policy.cwd);
  if (!samePaths(policy.protectedPaths, requiredProtected)) {
    throw new Error("Pi policy is missing Astra hard-protected paths");
  }
  if (policy.capabilities?.shell !== false || policy.capabilities?.network !== false || policy.capabilities?.delegation !== false) {
    throw new Error("Pi policy must fail closed when shell, network, or delegation is enabled");
  }
  for (const path of [...policy.readPaths, ...policy.writePaths]) {
    canonicalizePath(path, policy.cwd);
    if (isProtectedPath(path, policy.cwd)) throw new Error(`Pi policy scope is hard-protected: ${path}`);
  }
}

function blocked(reason) {
  return { block: true, reason, terminate: true };
}

/** Resolve symlinks for an existing target, or through the nearest existing parent for a new one. */
async function resolvePhysicalPath(path, cwd) {
  const lexicalPath = canonicalizePath(path, cwd);
  let current = lexicalPath;
  const missing = [];
  for (;;) {
    try {
      const existing = await realpath(current);
      return missing.length ? join(existing, ...missing) : existing;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function samePaths(actual, expected) {
  return actual.length === expected.length
    && new Set(actual).size === expected.length
    && expected.every((path) => actual.includes(path));
}
