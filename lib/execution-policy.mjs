import { isAbsolute, relative, resolve, sep } from "node:path";

/** Version for the adapter-independent policy shape passed to every invocation. */
export const EXECUTION_POLICY_VERSION = 1;

const CAPABILITIES = Object.freeze({ shell: false, network: false, delegation: false });

const PROTECTED_DIRECTORIES = new Set([".git", ".claude", ".codex", ".factory", ".agents"]);
const PROTECTED_FILES = new Set([
  "agents.md",
  "claude.md",
  "codex.md",
  "factory.md",
  ".mcp.json",
  "mcp.json",
]);

/**
 * Resolve a policy path lexically beneath cwd. Filesystem access is deliberately absent: the
 * adapter and its sandbox perform the eventual OS-level check, while this seam stays pure.
 */
export function canonicalizePath(path, cwd) {
  const root = canonicalRoot(cwd);
  if (typeof path !== "string" || !path.trim()) throw new TypeError("path must be a non-empty string");
  if (path.includes("\0")) throw new TypeError("path must not contain NUL");

  const raw = path.trim();
  const glob = raw.endsWith("/**");
  const withoutGlob = glob ? raw.slice(0, -3) : raw;
  if (withoutGlob.includes("*") || withoutGlob.includes("?") || withoutGlob.includes("[")) {
    throw new Error(`unsupported path pattern: ${path}`);
  }

  const canonical = resolve(root, withoutGlob || ".");
  if (!isWithin(root, canonical)) throw new Error(`path is outside policy root: ${path}`);
  return glob ? `${canonical}/**` : canonical;
}

/** Return the hard-protected paths represented in a serializable policy. */
export function protectedPaths(cwd) {
  const root = canonicalRoot(cwd);
  return [
    `${root}/.git`,
    `${root}/.env`,
    `${root}/.env.*`,
    `${root}/credentials`,
    `${root}/credentials.*`,
    `${root}/.claude`,
    `${root}/.codex`,
    `${root}/.factory`,
    `${root}/.agents`,
    `${root}/AGENTS.md`,
    `${root}/CLAUDE.md`,
    `${root}/CODEX.md`,
    `${root}/.mcp.json`,
    `${root}/mcp.json`,
  ];
}

/** Build the read-only scout profile. */
export function deriveScoutPolicy({ cwd } = {}) {
  return makePolicy("scout", cwd, [], [canonicalRoot(cwd)]);
}

/** Build the coordinator profile from its declared gate artifact paths. */
export function deriveCoordinatorPolicy({ cwd, artifactPaths } = {}) {
  const paths = requirePathList(artifactPaths, "artifactPaths");
  return makePolicy("coordinator", cwd, paths, [canonicalRoot(cwd)]);
}

/** Build a judge profile that can write exactly one persona audit artifact. */
export function deriveJudgePolicy({ cwd, auditPath } = {}) {
  if (typeof auditPath !== "string" || !auditPath.trim()) throw new TypeError("auditPath must be a path");
  return makePolicy("judge", cwd, [auditPath], [canonicalRoot(cwd)]);
}

/** Build a DAG worker profile from role.writeBoundary. */
export function deriveDagWorkerPolicy({ cwd, role, writeBoundary } = {}) {
  const boundary = writeBoundary ?? role?.writeBoundary;
  const paths = requirePathList(boundary, "role.writeBoundary");
  return makePolicy("dag-worker", cwd, paths, [canonicalRoot(cwd)]);
}

/**
 * Generic dispatcher useful to pipeline callers that already have a profile discriminator.
 * It accepts either deriveExecutionPolicy("scout", options) or
 * deriveExecutionPolicy({ profile: "scout", ...options }).
 */
export function deriveExecutionPolicy(profileOrOptions, options = {}) {
  const input = typeof profileOrOptions === "string"
    ? { ...options, profile: profileOrOptions }
    : { ...(profileOrOptions ?? {}) };
  const profile = normalizeProfile(input.profile);
  if (profile === "scout") return deriveScoutPolicy(input);
  if (profile === "coordinator") return deriveCoordinatorPolicy(input);
  if (profile === "judge") return deriveJudgePolicy(input);
  return deriveDagWorkerPolicy(input);
}

/** Check a candidate against a policy's read or write scope and its hard protections. */
export function isPathAllowed(policy, path, operation = "read") {
  if (!policy || !["read", "write"].includes(operation)) return false;
  let candidate;
  try {
    candidate = canonicalizePath(path, policy.cwd);
  } catch {
    return false;
  }
  if (isProtected(candidate, policy.cwd)) return false;

  const scopes = operation === "write" ? policy.writePaths : policy.readPaths;
  return (scopes ?? []).some((scope) => scopeAllows(scope, candidate, operation));
}

/** Alias with an explicit name for adapters that enforce policy at a tool boundary. */
export const isPolicyPathAllowed = isPathAllowed;

/** Check a single canonical-or-relative path against Astra's hard-protection rules. */
export function isProtectedPath(path, cwd) {
  try {
    return isProtected(canonicalizePath(path, cwd), cwd);
  } catch {
    return true;
  }
}

function makePolicy(profile, cwd, writes, reads) {
  const root = canonicalRoot(cwd);
  const readPaths = unique(reads.map((path) => canonicalizePath(path, root)));
  const writePaths = unique(writes.map((path) => {
    const canonical = canonicalizePath(path, root);
    if (isProtected(canonical, root)) throw new Error(`path is protected by execution policy: ${path}`);
    return canonical;
  }));

  return {
    version: EXECUTION_POLICY_VERSION,
    mode: "auto",
    profile,
    cwd: root,
    capabilities: { ...CAPABILITIES },
    readPaths,
    writePaths,
    protectedPaths: protectedPaths(root),
  };
}

function requirePathList(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must contain at least one path`);
  return value;
}

function normalizeProfile(profile) {
  if (profile === "dagWorker" || profile === "worker" || profile === "dag_worker") return "dag-worker";
  if (["scout", "coordinator", "judge", "dag-worker"].includes(profile)) return profile;
  throw new TypeError(`unknown execution policy profile: ${String(profile)}`);
}

function canonicalRoot(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) throw new TypeError("cwd must be a non-empty path");
  if (cwd.includes("\0")) throw new TypeError("cwd must not contain NUL");
  return resolve(cwd.trim());
}

function isWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function scopeAllows(scope, candidate, operation) {
  if (scope.endsWith("/**")) return isWithin(scope.slice(0, -3), candidate);
  if (operation === "read") return isWithin(scope, candidate);
  return scope === candidate;
}

function isProtected(candidate, cwd) {
  const root = canonicalRoot(cwd);
  if (!isWithin(root, candidate)) return true;
  const rel = relative(root, candidate);
  if (!rel) return false;
  const parts = rel.split(sep);
  const basename = parts.at(-1).toLowerCase();
  return parts.some((part) => {
    const lower = part.toLowerCase();
    return PROTECTED_DIRECTORIES.has(lower)
      || lower === ".env"
      || lower.startsWith(".env.")
      || lower === "credentials"
      || lower.startsWith("credentials.")
      || lower === "credential"
      || lower.startsWith("credential.");
  }) || PROTECTED_FILES.has(basename);
}

function unique(paths) {
  return [...new Set(paths)];
}
