import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeText, nowIso } from "./util.mjs";
import { ADAPTER_CAPABILITIES } from "./policy.mjs";
import { normalizeUsage } from "./usage.mjs";
import { compileClaudePolicy } from "./adapter-policies/claude.mjs";
import { compileCodexPolicy } from "./adapter-policies/codex.mjs";
import { compileDroidPolicy } from "./adapter-policies/droid.mjs";
import { compilePiPolicy } from "./adapter-policies/pi.mjs";

export { createSession, resumeSession, compactSession } from "./session.mjs";
export { calculateBudget, normalizeUsage } from "./usage.mjs";

// One adapter drives an entire Astra run. A gate never switches CLIs: the agent that wrote the
// product intent is the agent that writes the code, so its reasoning context stays coherent.
export const ADAPTERS = {
  claude: {
    id: "claude",
    bin: "claude",
    label: "Claude Code",
    notes: "Strongest at long-horizon reasoning gates (architecture, contract design).",
    session: { supportsResume: true, supportsCompact: true },
    supportsModel: true,
    supportsEffort: true,
    build: ({ prompt, role, model, effort, sessionId, resume = false, nativePolicy }) => ({
      argv: ["-p", "--output-format", "stream-json", "--verbose", ...(nativePolicy ? ["--settings", JSON.stringify(nativePolicy.settings)] : []), ...modelArgs(model, { effort: "--effort", effortValue: effort }), ...(resume && sessionId ? ["--resume", sessionId] : []), promptText(prompt, role)],
    }),
  },
  droid: {
    id: "droid",
    bin: "droid",
    label: "Factory Droid",
    notes: "High-speed vertical-slice generation; autonomous edit loop.",
    session: { supportsResume: true, supportsCompact: true },
    supportsModel: true,
    supportsEffort: true,
    build: ({ prompt, role, model, effort, sessionId, resume = false, nativePolicy }) => ({
      argv: [...(nativePolicy?.launch?.args ?? ["exec"]), ...(nativePolicy ? ["--settings", JSON.stringify({ commandBlocklist: nativePolicy.commandBlocklist, sandbox: nativePolicy.sandbox, delegation: nativePolicy.delegation })] : []), "--output-format", "stream-json", ...modelArgs(model, { effort: "--effort", effortValue: effort }), ...(resume && sessionId ? ["--resume", sessionId] : []), promptText(prompt, role)],
    }),
  },
  opencode: {
    id: "opencode",
    bin: "opencode",
    label: "OpenCode",
    notes: "Pragmatic audits and script generation; quiet headless output.",
    session: { supportsResume: true, supportsCompact: true },
    supportsModel: true,
    supportsEffort: false,
    build: ({ prompt, role, model, effort, sessionId, resume = false, nativePolicy }) => ({
      argv: [...(nativePolicy?.launch?.args ?? ["run", "--format", "json"]), ...modelArgs(model), ...(resume && sessionId ? ["--session", sessionId] : []), promptText(prompt, role)],
    }),
  },
  hermes: {
    id: "hermes",
    bin: "hermes",
    label: "Hermes",
    notes: "Native system-prompt slot; suits red-team adversarial passes.",
    session: { supportsResume: true, supportsCompact: true },
    supportsModel: true,
    supportsEffort: false,
    build: ({ prompt, role, model, sessionId, resume = false, nativePolicy }) => ({
      argv: [...(nativePolicy?.launch?.args ?? ["chat"]), ...modelArgs(model), ...(resume && sessionId ? ["--session", sessionId] : []), ...(role ? ["--system", role] : []), "--message", prompt],
    }),
  },
  codex: {
    id: "codex",
    bin: "codex",
    label: "OpenAI Codex",
    notes: "Fast static verification and focused unit-test generation.",
    session: { supportsResume: true, supportsCompact: true },
    stdinPrompt: true,
    supportsModel: true,
    supportsEffort: true,
    build: ({ prompt, role, model, effort, sessionId, resume = false, nativePolicy }) => ({
      // `codex exec -` is the documented non-interactive stdin form. A
      // prompt file makes Codex treat the path as the user message and breaks
      // callers that do not have a writable work directory.
      argv: [...(nativePolicy?.launch?.args ?? ["exec"]), ...(nativePolicy ? codexConfigArgs(nativePolicy.config) : []), ...(resume && sessionId ? ["resume", sessionId] : []), ...modelArgs(model), ...codexEffortArgs(effort), "--json", "-"],
      stdin: promptText(prompt, role),
    }),
  },
  pi: {
    id: "pi",
    bin: "pi",
    label: "Pi",
    notes: "Native TypeScript SDK execution with Pi's built-in coding tools.",
    session: { supportsResume: true, supportsCompact: true },
    sdk: true,
  },
};

export const ADAPTER_IDS = Object.keys(ADAPTERS);

export function capabilities(id) {
  getAdapter(id);
  return ADAPTER_CAPABILITIES[id];
}

export function getAdapter(id) {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(`unknown agent "${id}" — choose one of: ${ADAPTER_IDS.join(", ")}`);
  }
  return adapter;
}

export function detect(id) {
  const adapter = getAdapter(id);
  if (adapter.sdk) return detectSdk(adapter);
  return new Promise((resolve) => {
    const probe = spawn(process.platform === "win32" ? "where" : "which", [adapter.bin], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    probe.stdout.on("data", (chunk) => (out += chunk));
    probe.on("error", () => resolve({ id, installed: false, path: null }));
    probe.on("close", (code) =>
      resolve({ id, installed: code === 0 && out.trim().length > 0, path: out.trim().split("\n")[0] || null }),
    );
  });
}

async function detectSdk(adapter) {
  try {
    await import("@earendil-works/pi-coding-agent");
    return { id: adapter.id, installed: true, path: "native SDK" };
  } catch {
    return { id: adapter.id, installed: false, path: null };
  }
}

export async function detectAll() {
  return Promise.all(ADAPTER_IDS.map((id) => detect(id)));
}

const NATIVE_POLICY_COMPILERS = { claude: compileClaudePolicy, droid: compileDroidPolicy, codex: compileCodexPolicy, pi: compilePiPolicy };

async function compileNativePolicy(adapterId, executionPolicy, adapterCapabilities, policyCompiler, workDir) {
  if (policyCompiler) {
    return policyCompiler(adapterId, executionPolicy, adapterCapabilities);
  }
  let compiler = NATIVE_POLICY_COMPILERS[adapterId];
  if (!compiler) {
    const moduleName = adapterId === "opencode" ? "./adapter-policies/opencode.mjs" : adapterId === "hermes" ? "./adapter-policies/hermes.mjs" : null;
    if (moduleName) {
      try {
        const module = await import(moduleName);
        compiler = module[`compile${adapterId === "opencode" ? "OpenCode" : "Hermes"}Policy`] ?? module.compile;
      } catch {
        throw new Error(`${adapterId} native policy compiler is unavailable; refusing auto launch`);
      }
    }
  }
  if (typeof compiler !== "function") throw new Error(`${adapterId} native policy compiler is unavailable; refusing auto launch`);
  if (["droid", "codex", "opencode", "hermes"].includes(adapterId)) {
    return compiler({
      policy: executionPolicy,
      capabilities: adapterCapabilities,
      ...(adapterId === "codex" ? { configDir: join(workDir, ".astra-codex") } : {}),
    });
  }
  return compiler(executionPolicy);
}

/**
 * Run one headless turn of the selected agent backend.
 * Resolves with { ok, code, stdout, stderr, durationMs, argv } and never throws on non-zero exit.
 */
export async function invoke(adapterId, {
  prompt,
  role,
  cwd,
  logFile,
  timeoutMs = 30 * 60 * 1000,
  dryRun = false,
  workDir,
  sessionId,
  sessionKey,
  model,
  requestedModel: requestedModelInput,
  effectiveModel,
  warning,
  effort,
  resume = false,
  budgetTokens,
  compactAt,
  sessionDir,
  sessionPath,
  allowModelFallback = true,
  executionPolicy,
  adapterCapabilities,
  policyCompiler,
  outerSandbox,
}) {
  const adapter = getAdapter(adapterId);
  const requestedModel = requestedModelInput ?? model ?? null;
  const durableSessionId = sessionId ?? sessionKey ?? null;
  const nativePolicy = executionPolicy
    ? await compileNativePolicy(adapterId, executionPolicy, adapterCapabilities, policyCompiler, workDir ?? cwd)
    : null;
  const modelWarning = !adapter.supportsModel && requestedModel
    ? `Model request "${requestedModel}" is not supported by ${adapterId}; using the backend default.`
    : !adapter.supportsEffort && effort
      ? `Effort request "${effort}" is not supported by ${adapterId}; using the backend default.`
      : warning ?? null;
  if (adapter.sdk) return invokePi({ prompt, role, cwd, logFile, timeoutMs, dryRun, sessionId: durableSessionId, requestedModel, effectiveModel, warning: modelWarning, model, effort, budgetTokens, compactAt, sessionDir, sessionPath, resume, executionPolicy, nativePolicy });
  const promptFile = adapter.needsPromptFile ? join(workDir ?? cwd, `.astra-prompt-${Date.now()}.txt`) : undefined;
  const spec = adapter.build({ prompt, role, promptFile, sessionId: durableSessionId, requestedModel, effectiveModel, model: requestedModel, effort, resume, executionPolicy, nativePolicy });
  if (nativePolicy?.launch?.configDir) {
    spec.env = { ...(spec.env ?? {}), CODEX_HOME: nativePolicy.launch.configDir };
  }
  if (nativePolicy?.env) spec.env = { ...(spec.env ?? {}), ...nativePolicy.env };
  if (adapterId === "opencode" && nativePolicy?.config) {
    // OpenCode must consume the final Astra-owned config, never merge a user/project file.
    spec.env = { ...(spec.env ?? {}), OPENCODE_CONFIG_CONTENT: JSON.stringify(nativePolicy.config) };
    const configFlag = spec.argv.indexOf("--config");
    if (configFlag >= 0) spec.argv.splice(configFlag, 2);
  }

  for (const file of spec.files ?? []) {
    await writeText(file.path, file.content);
  }

  if (dryRun) {
    return {
      ok: true,
      code: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
      argv: [adapter.bin, ...spec.argv],
      ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
      ...(spec.env ? { env: spec.env } : {}),
      sessionId: durableSessionId,
      requestedModel,
      effectiveModel: effectiveModel ?? requestedModel,
      warning: modelWarning,
      usage: normalizeUsage(),
      ...(budgetTokens === undefined ? {} : { budget: { budgetTokens, compactAt } }),
      ...(executionPolicy ? { executionPolicy, nativePolicy } : {}),
      dryRun: true,
    };
  }

  if (nativePolicy?.outerSandboxRequired && typeof outerSandbox?.run !== "function") {
    throw new Error(`${adapterId} policy requires an outer sandbox; refusing unsandboxed launch`);
  }
  if (nativePolicy?.sandbox?.required && typeof outerSandbox?.run !== "function") {
    throw new Error(`${adapterId} policy requires an isolated backend for file writes; refusing launch`);
  }

  if (logFile) await ensureDir(join(logFile, ".."));
  const log = logFile ? createWriteStream(logFile, { flags: "a" }) : null;
  log?.write(`\n=== ${nowIso()} ${adapter.bin} ${spec.argv.map(redact).join(" ")}\n`);

  const started = Date.now();
  return new Promise((resolve) => {
    if (outerSandbox?.run) {
      outerSandbox.run(
        { program: adapter.bin, args: spec.argv },
        { cwd, env: spec.env ? { ...process.env, ...spec.env } : undefined, timeout: timeoutMs },
      ).then((result) => {
        const code = result.exitCode ?? 1;
        const stdout = result.stdout ?? "";
        const stderr = result.stderr ?? "";
        log?.write(stdout);
        log?.write(stderr);
        log?.end();
        resolve({
          ok: code === 0,
          code,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          argv: [adapter.bin, ...spec.argv],
          sessionId: extractSessionId(stdout) ?? durableSessionId,
          requestedModel,
          effectiveModel: extractModel(stdout) ?? effectiveModel ?? requestedModel,
          warning: modelWarning,
          usage: normalizeUsage(extractUsage(stdout)),
          ...(executionPolicy ? { executionPolicy, nativePolicy } : {}),
        });
      }).catch((error) => {
        log?.end();
        resolve({
          ok: false,
          code: 125,
          stdout: "",
          stderr: `outer sandbox execution failed: ${error.message}`,
          durationMs: Date.now() - started,
          argv: [adapter.bin, ...spec.argv],
          sessionId: durableSessionId,
          requestedModel,
          effectiveModel: effectiveModel ?? requestedModel,
          warning: modelWarning,
          usage: normalizeUsage(),
          ...(executionPolicy ? { executionPolicy, nativePolicy } : {}),
        });
      });
      return;
    }
    const child = spawn(adapter.bin, spec.argv, { cwd, env: spec.env ? { ...process.env, ...spec.env } : undefined, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      log?.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      log?.write(chunk);
    });
    // Every adapter runs headless. Close stdin even when the prompt is passed
    // as an argv value; otherwise a CLI waiting for EOF can hang forever.
    child.stdin.end(spec.stdin ?? "");
    child.on("error", (err) => {
      clearTimeout(timer);
      log?.end();
      resolve({
        ok: false,
        code: 127,
        stdout,
        stderr: `${stderr}${err.message}`,
        durationMs: Date.now() - started,
        argv: [adapter.bin, ...spec.argv],
        sessionId: extractSessionId(stdout) ?? durableSessionId,
        requestedModel,
        effectiveModel: extractModel(stdout) ?? effectiveModel ?? requestedModel,
        warning: modelWarning,
        usage: normalizeUsage(extractUsage(stdout)),
        ...(executionPolicy ? { executionPolicy, nativePolicy } : {}),
      });
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      log?.end();
      if (allowModelFallback && code !== 0 && requestedModel && modelUnavailable(stderr)) {
        const fallbackWarning = `Model fallback: requested "${requestedModel}" from ${adapterId}, but it is unavailable; using the backend default.`;
        const fallback = await invoke(adapterId, {
          prompt,
          role,
          cwd,
          logFile,
          timeoutMs,
          workDir,
          sessionId: durableSessionId,
          effort: null,
          resume,
          budgetTokens,
          compactAt,
          sessionDir,
          sessionPath,
          warning: fallbackWarning,
          allowModelFallback: false,
          executionPolicy,
          adapterCapabilities,
          policyCompiler,
          outerSandbox,
        });
        resolve({ ...fallback, requestedModel, warning: fallbackWarning });
        return;
      }
      resolve({
        ok: code === 0 && !timedOut,
        code: timedOut ? 124 : code ?? 1,
        stdout,
        stderr: timedOut ? `${stderr}\ntimed out after ${timeoutMs}ms` : stderr,
        durationMs: Date.now() - started,
        argv: [adapter.bin, ...spec.argv],
        sessionId: extractSessionId(stdout) ?? durableSessionId,
        requestedModel,
        effectiveModel: extractModel(stdout) ?? effectiveModel ?? requestedModel,
        warning: modelWarning,
        usage: normalizeUsage(extractUsage(stdout)),
        ...(executionPolicy ? { executionPolicy, nativePolicy } : {}),
      });
    });
  });
}

async function invokePi({ prompt, role, cwd, logFile, timeoutMs, dryRun, sessionId, requestedModel, effectiveModel, warning, model, effort, budgetTokens, compactAt, sessionDir, sessionPath, resume, executionPolicy, nativePolicy }) {
  const fullPrompt = role ? `${role}\n\n---\n\n${prompt}` : prompt;
  const argv = ["pi", "(native SDK)"];
  if (dryRun) {
    return {
      ok: true,
      code: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
      argv,
      sessionId: sessionId ?? null,
      requestedModel: requestedModel ?? model ?? null,
      effectiveModel: effectiveModel ?? requestedModel ?? model ?? null,
      warning: warning ?? (effort ? `Effort request "${effort}" is applied by Pi as its thinking level when available.` : null),
      usage: normalizeUsage(),
      ...(budgetTokens === undefined ? {} : { budget: { budgetTokens, compactAt } }),
      dryRun: true,
    };
  }

  const [{ createAgentSession, SessionManager, createCodingTools, createReadOnlyTools }] = await Promise.all([import("@earendil-works/pi-coding-agent")]);
  if (logFile) await ensureDir(join(logFile, ".."));
  const log = logFile ? createWriteStream(logFile, { flags: "a" }) : null;
  log?.write(`\n=== ${nowIso()} pi (native SDK)\n`);
  const started = Date.now();
  let stdout = "";
  let session;
  let timer;
  const write = (value) => {
    stdout += value;
    log?.write(value);
  };

  try {
    const sessionManager = await piSessionManager({ cwd, sessionId, sessionDir, sessionPath, resume, SessionManager });
    const toolNames = nativePolicy ? mapPiTools(nativePolicy.tools, cwd, createCodingTools, createReadOnlyTools) : undefined;
    const created = await createAgentSession({
      cwd,
      sessionManager,
      ...(nativePolicy ? { tools: toolNames, excludeTools: [...nativePolicy.excludeTools], resourceLoader: await piResourceLoader(cwd, sessionDir, executionPolicy) } : {}),
    });
    ({ session } = created);
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        write(event.assistantMessageEvent.delta);
      }
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([session.prompt(fullPrompt), timeout]);
    clearTimeout(timer);
    const stats = session.getSessionStats?.();
    unsubscribe();
    session.dispose();
    log?.end();
    return {
      ok: true,
      code: 0,
      stdout,
      stderr: "",
      durationMs: Date.now() - started,
      argv,
      sessionId: session.sessionId ?? sessionId ?? null,
      requestedModel: requestedModel ?? null,
      effectiveModel: modelName(session.model) ?? effectiveModel ?? requestedModel ?? null,
      warning: created.modelFallbackMessage ?? warning ?? null,
      usage: normalizeUsage(stats?.tokens),
      ...(executionPolicy ? { executionPolicy, nativePolicy } : {}),
    };
  } catch (error) {
    clearTimeout(timer);
    session?.dispose();
    log?.end();
    return {
      ok: false,
      code: error.message.startsWith("timed out") ? 124 : 1,
      stdout,
      stderr: error.message,
      durationMs: Date.now() - started,
      argv,
      sessionId: session?.sessionId ?? sessionId ?? null,
      requestedModel: requestedModel ?? null,
      effectiveModel: modelName(session?.model) ?? effectiveModel ?? requestedModel ?? null,
      warning: warning ?? null,
      usage: normalizeUsage(),
      ...(executionPolicy ? { executionPolicy, nativePolicy } : {}),
    };
  }
}

async function piSessionManager({ cwd, sessionId, sessionDir, sessionPath, resume, SessionManager }) {
  if (sessionPath) return SessionManager.open(sessionPath, sessionDir, cwd);
  if (!sessionDir) return sessionId ? SessionManager.inMemory(cwd, { id: sessionId }) : SessionManager.inMemory(cwd);
  if (resume && sessionId) {
    const sessions = await SessionManager.list(cwd, sessionDir);
    const existing = sessions.find((item) => item.id === sessionId);
    if (existing) return SessionManager.open(existing.path, sessionDir, cwd);
  }
  return SessionManager.create(cwd, sessionDir, sessionId ? { id: sessionId } : undefined);
}

function extractUsage(stdout) {
  for (const value of jsonValues(stdout)) {
    if (value?.usage) return value.usage;
    if (value?.result?.usage) return value.result.usage;
  }
  return undefined;
}

function extractSessionId(stdout) {
  for (const value of jsonValues(stdout)) {
    const id = value?.sessionId ?? value?.session_id ?? value?.threadId ?? value?.thread_id ?? value?.id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

function extractModel(stdout) {
  for (const value of jsonValues(stdout)) {
    const model = value?.effectiveModel ?? value?.model ?? value?.modelId ?? value?.model_id;
    if (typeof model === "string" && model) return model;
  }
  return null;
}

function jsonValues(stdout) {
  const values = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) continue;
    try { values.push(JSON.parse(trimmed)); } catch { /* human-readable CLI output */ }
  }
  return values;
}

function modelName(model) {
  if (!model || typeof model !== "object") return typeof model === "string" ? model : null;
  if (model.provider && model.id) return `${model.provider}/${model.id}`;
  return model.id ?? model.name ?? null;
}

function promptText(prompt, role) {
  return role ? `${role}\n\n---\n\n${prompt}` : prompt;
}

function modelArgs(model, options = {}) {
  const args = model ? ["--model", String(model)] : [];
  if (model && options.effort && options.effortValue) args.push(options.effort, String(options.effortValue));
  return args;
}

function codexEffortArgs(effort) {
  return effort ? ["-c", `model_reasoning_effort="${String(effort)}"`] : [];
}

function modelUnavailable(stderr) {
  return /(?:model).*(?:unknown|invalid|not found|unavailable|unsupported)|(?:unknown|invalid|unsupported).*(?:model)/i.test(String(stderr));
}

function codexConfigArgs(config) {
  const args = [];
  const visit = (value, prefix) => {
    for (const [key, child] of Object.entries(value ?? {})) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (child && typeof child === "object" && !Array.isArray(child)) visit(child, name);
      else args.push("--config", `${name}=${typeof child === "string" ? child : JSON.stringify(child)}`);
    }
  };
  visit(config, "");
  return args;
}

export function mapPiTools(names, cwd, createCodingTools, createReadOnlyTools) {
  const tools = names.includes("edit") || names.includes("write") ? createCodingTools(cwd) : createReadOnlyTools(cwd);
  const available = new Map(tools.map((tool) => [tool.name, tool]));
  const missing = names.filter((name) => !available.has(name));
  if (missing.length) throw new Error(`Pi policy tool IDs unavailable: ${missing.join(", ")}`);
  return names.map((name) => available.get(name));
}

async function piResourceLoader(cwd, sessionDir, executionPolicy) {
  const [{ DefaultResourceLoader }, { createPiToolCallGuard }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("./adapter-policies/pi.mjs"),
  ]);
  const guard = createPiToolCallGuard(executionPolicy);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: sessionDir ?? join(cwd, ".astra", "pi-agent"),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.on("tool_call", (event) => guard(event));
      },
    ],
  });
  await loader.reload();
  return loader;
}

function redact(arg) {
  return arg.length > 120 ? `${arg.slice(0, 117)}...` : arg;
}
