import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

const DEFAULT_DENY_READ = ["~/.ssh", "~/.aws", "~/.gnupg"];
const DEFAULT_DENY_WRITE = [".env", ".env.*", "*.pem", "*.key"];

/** Error raised whenever an OS sandbox cannot be proven active. */
export class SandboxUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SandboxUnavailableError";
  }
}

/**
 * Create the only command-execution seam used by sandboxed command nodes.
 *
 * The runtime is initialized once, with explicit grants. `run` always executes
 * the runtime's wrapped command; it never falls back to the original command.
 * A rootless OCI backend can implement this same `{ run, close }` shape later.
 */
export async function createCommandSandbox({
  cwd,
  allowRead = [],
  allowWrite = [],
  denyRead = [],
  denyWrite = [],
  allowedDomains = [],
  deniedDomains = ["*"],
  manager = SandboxManager,
  platform = process.platform,
  commandExecutor = execute,
} = {}) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new TypeError("sandbox cwd is required");
  }
  if (typeof manager?.initialize !== "function" || typeof manager?.wrapWithSandbox !== "function") {
    throw new SandboxUnavailableError("sandbox runtime manager is unavailable");
  }
  if (platform !== "darwin" && platform !== "linux") {
    throw new SandboxUnavailableError(`sandbox backend does not support platform ${platform}`);
  }
  if (typeof manager.isSupportedPlatform === "function" && !manager.isSupportedPlatform(platform)) {
    throw new SandboxUnavailableError(`sandbox runtime does not support platform ${platform}`);
  }
  if (typeof manager.checkDependencies === "function") {
    const dependencyStatus = manager.checkDependencies();
    if (dependencyStatus === false || dependencyStatus?.errors?.length) {
      throw new SandboxUnavailableError("sandbox runtime dependencies are unavailable");
    }
  }
  const probePath = join(tmpdir(), `.astra-sandbox-probe-${randomBytes(12).toString("hex")}`);

  const config = {
    network: {
      allowedDomains: [...allowedDomains],
      // Strict allowlist prevents a runtime permission callback from becoming
      // an implicit network grant.
      deniedDomains: [...deniedDomains],
      strictAllowlist: true,
      allowLocalBinding: false,
      allowUnixSockets: [],
    },
    filesystem: {
      allowRead: [...allowRead],
      allowWrite: [...allowWrite],
      denyRead: unique([...DEFAULT_DENY_READ, ...denyRead]),
      // The probe is denied even when a caller grants a broad temporary path;
      // denyWrite takes precedence and makes startup proof deterministic.
      denyWrite: unique([...DEFAULT_DENY_WRITE, ...denyWrite, probePath]),
    },
  };

  let initialized = false;
  try {
    await manager.initialize(config);
    initialized = true;

    if (typeof manager.isSandboxingEnabled === "function" && !manager.isSandboxingEnabled()) {
      throw new SandboxUnavailableError("sandbox runtime initialized without enabling isolation");
    }

    if (typeof manager.waitForNetworkInitialization === "function") {
      const ready = await manager.waitForNetworkInitialization();
      if (ready === false) throw new Error("sandbox network enforcement did not initialize");
    }

    await proveSandbox(manager, cwd, platform, commandExecutor, probePath);
  } catch (error) {
    if (initialized) await resetQuietly(manager);
    if (error instanceof SandboxUnavailableError) throw error;
    throw new SandboxUnavailableError(`sandbox startup preflight failed: ${error.message}`, { cause: error });
  }

  let closed = false;
  return {
    config,
    async run({ program, args = [] }, { cwd: runCwd = cwd, signal, timeout } = {}) {
      if (closed) throw new SandboxUnavailableError("sandbox backend is closed");
      if (typeof program !== "string" || program.length === 0) throw new TypeError("sandbox program is required");
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
        throw new TypeError("sandbox args must be an array of strings");
      }
      const command = [program, ...args].map(shellQuote).join(" ");
      const wrapped = await manager.wrapWithSandbox(command);
      assertWrapped(wrapped, command, platform);
      return commandExecutor(wrapped, runCwd, { signal, timeout });
    },
    async close() {
      if (closed) return;
      closed = true;
      await manager.reset();
    },
  };
}

export const createSandboxBackend = createCommandSandbox;

async function proveSandbox(manager, cwd, platform, commandExecutor, probePath) {
  const probe = `touch ${shellQuote(probePath)}`;
  try {
    const wrapped = await manager.wrapWithSandbox(probe);
    assertWrapped(wrapped, probe, platform);
    const result = await commandExecutor(wrapped, cwd);
    const escaped = existsSync(probePath);
    if (escaped || result.exitCode === 0) {
      throw new SandboxUnavailableError("sandbox wrapper is ineffective: forbidden write succeeded");
    }
  } finally {
    if (existsSync(probePath)) unlinkSync(probePath);
  }
}

function assertWrapped(wrapped, original, platform) {
  if (typeof wrapped !== "string" || wrapped.trim() === original.trim()) {
    throw new SandboxUnavailableError("sandbox wrapper is ineffective: runtime returned the original command");
  }
  const marker = platform === "darwin" ? /\bsandbox-exec\b/ : /\bbwrap\b/;
  if (!marker.test(wrapped)) {
    throw new SandboxUnavailableError(`sandbox wrapper is ineffective: ${platform} OS wrapper is missing`);
  }
}

function execute(command, cwd, { signal, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer;
    if (timeout > 0) timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code, signalName) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ exitCode: code, signal: signalName, stdout, stderr });
    });
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function unique(values) {
  return [...new Set(values)];
}

async function resetQuietly(manager) {
  try {
    await manager.reset();
  } catch {
    // Preserve the startup failure; cleanup is best effort.
  }
}
