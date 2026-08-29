#!/usr/bin/env node

/**
 * Small, dependency-free MCP/JSON-RPC facade for Astra's existing runtime.
 *
 * The CLI intentionally owns presentation and process exit codes. This module owns the
 * transport boundary only: it turns JSON-RPC requests into calls to the same ledger, gate,
 * pipeline, and interaction modules used by the CLI. Keeping that boundary here makes it safe
 * for Claude, Codex, Factory, or another MCP host to drive one run without importing bin/astra.mjs
 * (which starts the CLI as a side effect).
 */

import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAdapter } from "./adapters.mjs";
import { checkGate, GATES, gateId, getGate, GATE_IDS } from "./gates.mjs";
import {
  advance as advanceLedger,
  emptyLedger,
  loadLedger,
  markCleared,
  markFailed,
  markRan,
  saveLedger,
  loop as loopLedger,
} from "./ledger.mjs";
import {
  prepareGatePrompt,
  prepareNodePacket,
  prepareReviewerPackets,
  runDesignGate,
  runExecution,
} from "./pipeline.mjs";
import { loadSchema } from "./prompt.mjs";
import { REL, runRoot } from "./paths.mjs";
import { readInteraction, respondInteraction } from "./policy.mjs";
import { RUNTIME_IDS, getRuntime } from "./runtime/index.mjs";
import { ensureDir, slugify } from "./util.mjs";
import { WORKER_MODELS } from "./broker.mjs";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_INFO = Object.freeze({ name: "astra-os", version: "0.2.4" });
export const MAX_MESSAGE_BYTES = 1024 * 1024;

const OPERATION_NAMES = Object.freeze([
  "start",
  "check",
  "status",
  "run",
  "gate",
  "advance",
  "loop",
  "visualizer",
  "approve",
  "respond",
  "complete",
  "session",
]);

const AGENTS = ["claude", "opencode", "codex", "droid", "hermes", "pi"];
const JUDGES = ["solo", "magi"];

const COMMON_RUN_PROPERTIES = {
  cwd: { type: "string", description: "Project directory; defaults to the server working directory." },
  out: { type: "string", description: "Run root, relative to cwd unless absolute." },
  root: { type: "string", description: "Alias for out." },
  slug: { type: "string", description: "Existing run slug." },
};

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "astra_start",
    description: "Create an Astra run and its initial product gate ledger.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["intent"],
      properties: {
        intent: { type: "string", minLength: 1, description: "Plain-language product intent." },
        agent: { type: "string", enum: AGENTS, default: "claude" },
        judge: { type: "string", enum: JUDGES, default: "solo" },
        runtime: { type: "string", enum: RUNTIME_IDS, default: "local" },
        budgetTokens: { type: "integer", minimum: 1, description: "Optional visible token budget." },
        interfaceMode: { type: "string", enum: ["gui", "tui"], default: "tui" },
        slug: { type: "string" },
        ...COMMON_RUN_PROPERTIES,
      },
    },
  },
  {
    name: "astra_check",
    description: "Read the current Astra ledger, validate its gate artifacts, and report pending interaction.",
    inputSchema: { type: "object", additionalProperties: false, properties: COMMON_RUN_PROPERTIES },
  },
  {
    name: "astra_status",
    description: "Compatibility alias for astra_check.",
    inputSchema: { type: "object", additionalProperties: false, properties: COMMON_RUN_PROPERTIES },
  },
  {
    name: "astra_run",
    description: "Run the current Astra gate; artifacts are persisted before the result returns.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...COMMON_RUN_PROPERTIES,
        gate: { type: "string", description: "Current gate id or number." },
        agent: { type: "string", enum: AGENTS },
        judge: { type: "string", enum: JUDGES },
        runtime: { type: "string", enum: RUNTIME_IDS },
        all: { type: "boolean", description: "Run every remaining gate; requires human:true." },
        human: { type: "boolean", description: "Explicitly authorize all-gate auto-advance." },
        dryRun: { type: "boolean" },
        slice: { type: "string" },
        concurrency: { type: "integer", minimum: 1 },
        maxAttempts: { type: "integer", minimum: 1 },
        timeoutMs: { type: "integer", minimum: 1 },
        specialists: { type: "boolean" },
      },
    },
  },
  {
    name: "astra_gate",
    description: "Prepare the current gate prompt and review contracts without running a worker.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...COMMON_RUN_PROPERTIES,
        gate: { type: "string", description: "Gate id or number; defaults to the current gate." },
        nodeId: { type: "string", description: "Gate 5 node id; required for a node packet." },
        judge: { type: "string", enum: JUDGES },
      },
    },
  },
  {
    name: "astra_advance",
    description: "Advance the run after its current gate has been cleared.",
    inputSchema: { type: "object", additionalProperties: false, properties: COMMON_RUN_PROPERTIES },
  },
  {
    name: "astra_loop",
    description: "Loop a run back to an earlier gate with its bounded rework budget.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["to", "reason"],
      properties: {
        ...COMMON_RUN_PROPERTIES,
        to: { type: "string", description: "Earlier gate id or number." },
        reason: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "astra_visualizer",
    description: "Start, inspect, or stop the run visualizer without opening a browser.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...COMMON_RUN_PROPERTIES,
        action: { type: "string", enum: ["start", "status", "stop"], default: "status" },
        port: { type: "integer", minimum: 0, maximum: 65535, default: 4319 },
        host: { type: "string", minLength: 1, default: "127.0.0.1" },
      },
    },
  },
  {
    name: "astra_approve",
    description: "Clear a validated gate after an explicit human decision.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["human"],
      properties: {
        ...COMMON_RUN_PROPERTIES,
        gate: { type: "string" },
        human: { type: "boolean", const: true, description: "Must be true; approval is human-only." },
      },
    },
  },
  {
    name: "astra_respond",
    description: "Resolve a pending command approval or agent-input interaction using its token.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["requestId", "action", "resumeToken"],
      properties: {
        ...COMMON_RUN_PROPERTIES,
        requestId: { type: "string", minLength: 1 },
        resumeToken: { type: "string", minLength: 1 },
        action: { type: "string", enum: ["approve", "deny", "answer"] },
        value: { type: "string" },
      },
    },
  },
  {
    name: "astra_complete",
    description: "Close an Astra run without changing its existing artifacts.",
    inputSchema: { type: "object", additionalProperties: false, properties: COMMON_RUN_PROPERTIES },
  },
  {
    name: "astra_session",
    description: "Inspect, list, open, resume, or close the Astra run session for a project.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...COMMON_RUN_PROPERTIES,
        action: { type: "string", enum: ["get", "list", "open", "start", "resume", "close", "complete"], default: "get" },
        intent: { type: "string" },
        agent: { type: "string", enum: AGENTS },
        judge: { type: "string", enum: JUDGES },
        runtime: { type: "string", enum: RUNTIME_IDS },
        human: { type: "boolean" },
      },
    },
  },
]);

export const MCP_TOOLS = TOOL_DEFINITIONS;
export const TOOLS = TOOL_DEFINITIONS;

const TOOL_TO_OPERATION = Object.freeze(
  Object.fromEntries(TOOL_DEFINITIONS.map((tool) => [tool.name, tool.name.slice("astra_".length)])),
);

const JSON_RPC_ERRORS = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  operation: -32001,
  approval: -32002,
  noRun: -32004,
});

/** Error that is safe to return over the protocol without exposing a stack or cause chain. */
export class McpError extends Error {
  constructor(message, { code = JSON_RPC_ERRORS.operation, data } = {}) {
    super(String(message));
    this.name = "McpError";
    this.code = code;
    this.data = data;
  }
}

function invalidParams(message, data) {
  return new McpError(message, { code: JSON_RPC_ERRORS.invalidParams, data });
}

function noRun(message) {
  return new McpError(message, { code: JSON_RPC_ERRORS.noRun });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, name, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw invalidParams(`${name} is required`);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) throw invalidParams(`${name} must be a non-empty string`);
  return value;
}

function bool(value, name, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") throw invalidParams(`${name} must be a boolean`);
  return value;
}

function positiveInteger(value, name, defaultValue) {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1) throw invalidParams(`${name} must be a positive integer`);
  return value;
}

function normalizedGate(value, name = "gate") {
  try {
    return gateId(text(value, name, { required: true }));
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw invalidParams(error instanceof Error ? error.message : String(error));
  }
}

function normalizedInput(params) {
  if (params === undefined) return {};
  if (!isRecord(params)) throw invalidParams("params must be a JSON object");
  return params;
}

function normalizedCwd(input, baseCwd) {
  const value = input.cwd === undefined ? baseCwd : text(input.cwd, "cwd", { required: true });
  return resolve(baseCwd, value);
}

function normalizedRoot(input, cwd) {
  const out = input.out ?? input.root;
  if (out === undefined) return undefined;
  return isAbsolute(text(out, "out", { required: true })) ? out : resolve(cwd, out);
}

function sessionId(root, slug) {
  return `${slug}:${root}`;
}

function summarizeLedger(ledger, root) {
  return {
    sessionId: sessionId(root, ledger.meta.slug),
    runId: ledger.meta.slug,
    slug: ledger.meta.slug,
    intent: ledger.meta.intent,
    agent: ledger.meta.agent,
    judge: ledger.meta.judge,
    runtime: ledger.meta.runtime ?? "local",
    phase: ledger.phase,
    complete: Boolean(ledger.complete),
    root,
    updatedAt: ledger.meta.updatedAt,
  };
}

async function brokerApi() {
  // The broker is an optional companion surface while keeping this transport usable on the
  // original Astra runtime. Root integration can ship it without changing this module's API.
  try {
    return await import("./broker.mjs");
  } catch {
    return null;
  }
}

async function loadBrokerSession(root) {
  const broker = await brokerApi();
  return broker?.loadSession ? broker.loadSession(root) : null;
}

async function initializeBrokerSession(root, input, defaults) {
  const broker = await brokerApi();
  if (!broker?.initializeSession) return null;
  const budgetTokens = input.budgetTokens === undefined ? null : positiveInteger(input.budgetTokens, "budgetTokens", undefined);
  return broker.initializeSession(root, {
    slug: defaults.slug,
    harness: defaults.agent,
    budgetTokens,
    interfaceMode: input.interfaceMode ?? "tui",
    transport: "mcp",
  });
}

async function mutateBrokerSession(root, mutate) {
  const broker = await brokerApi();
  return broker?.mutateSession ? broker.mutateSession(root, mutate) : null;
}

async function listRuns(cwd) {
  const base = join(cwd, ".astra");
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = join(base, entry.name);
    const ledger = await loadLedger(root);
    if (ledger) runs.push({ cwd, root, ledger });
  }
  return runs;
}

async function resolveRun(input, baseCwd, { allowComplete = true } = {}) {
  const cwd = normalizedCwd(input, baseCwd);
  const root = normalizedRoot(input, cwd);
  if (root) {
    const ledger = await loadLedger(root);
    if (!ledger) throw noRun(`no Astra run at ${root}`);
    if (!allowComplete && ledger.complete) throw noRun(`run "${ledger.meta.slug}" is already complete`);
    return { cwd, root, ledger };
  }

  const runs = await listRuns(cwd);
  if (!runs.length) throw noRun(`no Astra run in ${cwd} — start one first`);
  const requestedSlug = input.slug === undefined ? undefined : text(input.slug, "slug", { required: true });
  if (requestedSlug) {
    const match = runs.find((run) => run.ledger.meta.slug === requestedSlug);
    if (!match) throw noRun(`no Astra run with slug "${requestedSlug}"`);
    if (!allowComplete && match.ledger.complete) throw noRun(`run "${requestedSlug}" is already complete`);
    return match;
  }

  const active = runs.filter((run) => !run.ledger.complete);
  if (!active.length) throw noRun(`no active Astra run in ${cwd} — start one first`);
  if (active.length > 1) {
    throw noRun(`multiple active Astra runs — pass slug: ${active.map((run) => run.ledger.meta.slug).join(", ")}`);
  }
  return active[0];
}

function runContext(run, input) {
  const ledger = run.ledger;
  const agent = input.agent === undefined ? ledger.meta.agent : text(input.agent, "agent", { required: true });
  const concurrency = positiveInteger(input.concurrency, "concurrency", 2);
  const maxAttempts = positiveInteger(input.maxAttempts, "maxAttempts", 2);
  const timeoutMs = input.timeoutMs === undefined ? undefined : positiveInteger(input.timeoutMs, "timeoutMs", undefined);
  return {
    cwd: run.cwd,
    root: run.root,
    slug: ledger.meta.slug,
    intent: ledger.meta.intent,
    agent,
    judge: input.judge === undefined ? ledger.meta.judge : text(input.judge, "judge", { required: true }),
    runtime: input.runtime === undefined ? ledger.meta.runtime ?? "local" : text(input.runtime, "runtime", { required: true }),
    concurrency,
    slice: input.slice === undefined ? null : text(input.slice, "slice", { required: true }),
    maxAttempts,
    dryRun: bool(input.dryRun, "dryRun"),
    specialists: bool(input.specialists, "specialists", true),
    timeoutMs,
    budgetTokens: ledger.meta.budgetTokens ?? null,
    workerModel: WORKER_MODELS[agent] ?? { model: null, effort: null },
  };
}

function validateStart(input) {
  const intent = text(input.intent, "intent", { required: true });
  const agent = input.agent === undefined ? "claude" : text(input.agent, "agent", { required: true });
  const judge = input.judge === undefined ? "solo" : text(input.judge, "judge", { required: true });
  const runtime = input.runtime === undefined ? "local" : text(input.runtime, "runtime", { required: true });
  if (!AGENTS.includes(agent)) throw invalidParams(`agent must be one of: ${AGENTS.join(", ")}`);
  if (!JUDGES.includes(judge)) throw invalidParams(`judge must be one of: ${JUDGES.join(", ")}`);
  if (!RUNTIME_IDS.includes(runtime)) throw invalidParams(`runtime must be one of: ${RUNTIME_IDS.join(", ")}`);
  getAdapter(agent);
  getRuntime(runtime);
  return { intent, agent, judge, runtime };
}

async function startOperation(input, baseCwd) {
  const { intent, agent, judge, runtime } = validateStart(input);
  const cwd = normalizedCwd(input, baseCwd);
  const slug = input.slug === undefined ? slugify(intent) : slugify(text(input.slug, "slug", { required: true }));
  const root = normalizedRoot(input, cwd) ?? runRoot(cwd, slug);
  const active = (await listRuns(cwd)).find((run) => !run.ledger.complete);
  if (active) {
    throw new McpError(
      `a run for "${active.ledger.meta.slug}" is already active (phase ${active.ledger.phase})`,
      { code: JSON_RPC_ERRORS.operation },
    );
  }

  await ensureDir(root);
  if ((input.out !== undefined || input.root !== undefined) && await loadLedger(root)) {
    throw new McpError(`an Astra run already exists at ${root}`, { code: JSON_RPC_ERRORS.operation });
  }
  const ledger = emptyLedger({ slug, intent, agent, judge, runRoot: root, cwd });
  ledger.meta.runtime = runtime;
  if (input.budgetTokens !== undefined) {
    ledger.meta.budgetTokens = positiveInteger(input.budgetTokens, "budgetTokens", undefined);
  }
  await saveLedger(root, ledger);
  const session = await initializeBrokerSession(root, input, { slug, agent });
  return {
    ok: true,
    created: true,
    ...summarizeLedger(ledger, root),
    session,
    ledger,
  };
}

async function statusOperation(input, baseCwd) {
  const run = await resolveRun(input, baseCwd);
  const gate = getGate(run.ledger.phase);
  const validation = await checkGate(run.root, gate.id);
  const interaction = await readInteraction(run.root);
  const session = await loadBrokerSession(run.root);
  return {
    ok: true,
    ...summarizeLedger(run.ledger, run.root),
    ledger: run.ledger,
    gate: { id: gate.id, n: gate.n, name: gate.name, status: run.ledger.gates[gate.id]?.status ?? "pending" },
    validation,
    interaction,
    session,
  };
}

async function gateOperation(input, baseCwd) {
  const run = await resolveRun(input, baseCwd);
  const id = input.gate === undefined ? run.ledger.phase : normalizedGate(input.gate);
  if (id !== run.ledger.phase) {
    throw new McpError(`ledger is at "${run.ledger.phase}", not "${id}"`, { code: JSON_RPC_ERRORS.operation });
  }
  if (input.judge !== undefined) {
    const judge = text(input.judge, "judge", { required: true });
    if (!JUDGES.includes(judge)) throw invalidParams(`judge must be one of: ${JUDGES.join(", ")}`);
  }
  const gate = getGate(id);
  const validation = await checkGate(run.root, gate.id);
  const ctx = runContext(run, input);
  const result = {
    ok: true,
    ...summarizeLedger(run.ledger, run.root),
    gate: { id: gate.id, n: gate.n, name: gate.name, status: run.ledger.gates[gate.id]?.status ?? "pending" },
    validation,
    contracts: await Promise.all(gate.artifacts.map(async (spec) => ({
      key: spec.key,
      path: REL[spec.key],
      kind: spec.kind,
      minBytes: spec.minBytes ?? null,
      schema: spec.schema ? await loadSchema(spec.schema) : null,
    }))),
  };

  if (gate.id === "execute") {
    const nodeId = text(input.nodeId, "nodeId", { required: true });
    try {
      result.nodePacket = await prepareNodePacket(ctx, nodeId);
    } catch (error) {
      throw invalidParams(error instanceof Error ? error.message : String(error));
    }
    return result;
  }

  const prompt = await prepareGatePrompt(ctx, gate.id);
  result.prompt = prompt.prompt;
  result.role = prompt.role;
  result.roleName = prompt.roleName;
  if (gate.id === "architecture") result.reviewerPackets = await prepareReviewerPackets(ctx);
  return result;
}

async function advanceOperation(input, baseCwd) {
  const run = await resolveRun(input, baseCwd, { allowComplete: false });
  let ledger;
  try {
    ledger = advanceLedger(run.ledger);
  } catch (error) {
    throw new McpError(error instanceof Error ? error.message : String(error), { code: JSON_RPC_ERRORS.operation });
  }
  await saveLedger(run.root, ledger);
  return { ok: true, ...summarizeLedger(ledger, run.root), ledger };
}

async function loopOperation(input, baseCwd) {
  const to = normalizedGate(input.to, "to");
  const reason = text(input.reason, "reason", { required: true });
  const run = await resolveRun(input, baseCwd, { allowComplete: false });
  let ledger;
  try {
    ledger = loopLedger(run.ledger, to, reason);
  } catch (error) {
    throw new McpError(error instanceof Error ? error.message : String(error), { code: JSON_RPC_ERRORS.operation });
  }
  await saveLedger(run.root, ledger);
  return { ok: true, ...summarizeLedger(ledger, run.root), ledger };
}

function portNumber(value) {
  if (value === undefined) return 4319;
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw invalidParams("port must be an integer from 0 to 65535");
  }
  return value;
}

async function visualizerOperation(input, baseCwd, visualizers, startVisualizerOverride) {
  const run = await resolveRun(input, baseCwd);
  const action = input.action === undefined ? "status" : text(input.action, "action", { required: true });
  if (!["start", "status", "stop"].includes(action)) throw invalidParams("action must be start, status, or stop");
  const current = visualizers.get(run.root);

  if (action === "start") {
    if (current) return { ok: true, action, running: true, runRoot: run.root, url: current.url };
    const startVisualizer = startVisualizerOverride ?? (await import("../visualizer/server.mjs")).startVisualizer;
    const host = input.host === undefined ? "127.0.0.1" : text(input.host, "host", { required: true });
    const visualizer = await startVisualizer({ runRoot: run.root, port: portNumber(input.port), host, open: false });
    visualizers.set(run.root, visualizer);
    return { ok: true, action, running: true, runRoot: run.root, url: visualizer.url };
  }

  if (action === "stop") {
    if (current) {
      await current.close();
      visualizers.delete(run.root);
    }
    return { ok: true, action, running: false, runRoot: run.root };
  }

  return { ok: true, action, running: Boolean(current), runRoot: run.root, ...(current ? { url: current.url } : {}) };
}

function gateResult(result, gate, ledger) {
  return {
    ok: Boolean(result?.ok),
    gate: gate.id,
    gateNumber: gate.n,
    detail: result?.detail ?? result?.summary ?? (result?.ok ? "passed" : "failed"),
    ...(result?.dryRun ? { dryRun: true } : {}),
    ...(result?.harnessFailure ? { harnessFailure: true } : {}),
    ...(result?.argv ? { argv: result.argv } : {}),
    ledger,
  };
}

async function executeGate(ctx, gate, dependencies) {
  const logger = dependencies.logger;
  if (gate.execute) {
    const planCheck = await dependencies.checkGate(ctx.root, "plan");
    if (!planCheck.ok) {
      return { ok: false, detail: `gate 4 artifacts are invalid: ${planCheck.checks.filter((check) => !check.ok).map((check) => check.path).join(", ")}` };
    }
    const execution = await dependencies.runExecution(ctx, { log: logger });
    const verdict = await dependencies.checkGate(ctx.root, gate.id);
    return { ok: execution.status === "passed" && verdict.ok, detail: `execution ${execution.status}` };
  }
  return dependencies.runDesignGate(ctx, gate.id, { log: logger });
}

async function runOperation(input, baseCwd, dependencies) {
  const run = await resolveRun(input, baseCwd, { allowComplete: false });
  const ctx = runContext(run, input);
  const requestedGate = input.gate === undefined ? undefined : normalizedGate(input.gate);
  if (requestedGate && requestedGate !== run.ledger.phase) {
    throw new McpError(`ledger is at "${run.ledger.phase}", not "${requestedGate}"`, { code: JSON_RPC_ERRORS.operation });
  }
  await mutateBrokerSession(run.root, (session) => {
    session.status = "running";
    if (session.coordinator) session.coordinator.status = "running";
  });
  if (!AGENTS.includes(ctx.agent)) throw invalidParams(`agent must be one of: ${AGENTS.join(", ")}`);
  if (!JUDGES.includes(ctx.judge)) throw invalidParams(`judge must be one of: ${JUDGES.join(", ")}`);
  if (!RUNTIME_IDS.includes(ctx.runtime)) throw invalidParams(`runtime must be one of: ${RUNTIME_IDS.join(", ")}`);
  getAdapter(ctx.agent);
  getRuntime(ctx.runtime);

  const all = bool(input.all, "all");
  if (all && input.human !== true) {
    throw new McpError("all-gate execution requires explicit human:true", { code: JSON_RPC_ERRORS.approval });
  }

  let ledger = run.ledger;
  const gates = [];
  for (;;) {
    const gate = getGate(ledger.phase);
    let result;
    try {
      result = await executeGate(ctx, gate, dependencies);
    } catch (error) {
      result = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }

    if (ctx.dryRun) {
      return { ok: true, dryRun: true, gate: gate.id, gateNumber: gate.n, preview: result, ledger };
    }

    ledger = result.ok ? markRan(ledger, gate.id, result.detail) : markFailed(ledger, gate.id, result.detail);
    await saveLedger(run.root, ledger);
    gates.push(gateResult(result, gate, ledger));
    if (!result.ok || !all) {
      return {
        ok: Boolean(result.ok),
        ...(result.harnessFailure ? { harnessFailure: true } : {}),
        gate: gate.id,
        gates,
        ...summarizeLedger(ledger, run.root),
        ledger,
      };
    }

    ledger = markCleared(ledger, gate.id, "mcp run --all (human:true)");
    if (gate.id === GATE_IDS.at(-1)) {
      ledger.complete = true;
      await saveLedger(run.root, ledger);
      return { ok: true, gate: gate.id, gates, ...summarizeLedger(ledger, run.root), ledger };
    }
    ledger = advanceLedger(ledger);
    await saveLedger(run.root, ledger);
  }
}

async function approveOperation(input, baseCwd) {
  if (input.human !== true) {
    throw new McpError("gate approval is human-only; pass human:true after reviewing the artifacts", { code: JSON_RPC_ERRORS.approval });
  }
  const run = await resolveRun(input, baseCwd);
  const requestedGate = input.gate === undefined ? run.ledger.phase : normalizedGate(input.gate);
  if (requestedGate !== run.ledger.phase) {
    throw new McpError(`ledger is at "${run.ledger.phase}", not "${requestedGate}"`, { code: JSON_RPC_ERRORS.operation });
  }
  const verdict = await checkGate(run.root, requestedGate, { requireMaterialization: requestedGate === "product" });
  if (!verdict.ok) {
    throw new McpError(`gate "${requestedGate}" artifacts are invalid`, {
      code: JSON_RPC_ERRORS.operation,
      data: { validation: verdict },
    });
  }
  const ledger = markCleared(run.ledger, requestedGate, "human (mcp)");
  await saveLedger(run.root, ledger);
  return { ok: true, approved: requestedGate, ...summarizeLedger(ledger, run.root), ledger };
}

async function respondOperation(input, baseCwd) {
  const requestId = text(input.requestId, "requestId", { required: true });
  const action = text(input.action, "action", { required: true });
  if (!["approve", "deny", "answer"].includes(action)) {
    throw invalidParams("action must be approve, deny, or answer");
  }
  const run = await resolveRun(input, baseCwd);
  const current = await readInteraction(run.root);
  if (!current || current.requestId !== requestId) throw noRun(`no pending interaction "${requestId}"`);
  const resumeToken = text(input.resumeToken ?? input.token, "resumeToken", { required: true });
  const value = action === "answer" ? text(input.value, "value", { required: true }) : undefined;
  const result = await respondInteraction(run.root, {
    requestId,
    resumeToken,
    action,
    ...(value === undefined ? {} : { value }),
  });
  if (!result.ok) {
    throw new McpError(result.errors.join("; "), { code: JSON_RPC_ERRORS.operation });
  }
  return { ok: true, interaction: result.data, ...summarizeLedger(run.ledger, run.root) };
}

async function completeOperation(input, baseCwd) {
  const run = await resolveRun(input, baseCwd);
  const ledger = { ...run.ledger, complete: true };
  await saveLedger(run.root, ledger);
  await mutateBrokerSession(run.root, (session) => {
    session.status = "complete";
    if (session.coordinator) session.coordinator.status = "complete";
  });
  return { ok: true, ...summarizeLedger(ledger, run.root), ledger };
}

async function sessionOperation(input, baseCwd, server) {
  const action = input.action === undefined ? "get" : text(input.action, "action", { required: true });
  if (action === "list") {
    const cwd = normalizedCwd(input, baseCwd);
    const runs = await listRuns(cwd);
    return { ok: true, cwd, runs: runs.map((run) => summarizeLedger(run.ledger, run.root)) };
  }
  if (action === "start" || action === "open") return server.callOperation("start", input);
  if (action === "close" || action === "complete") return server.callOperation("complete", input);
  if (!["get", "resume"].includes(action)) throw invalidParams(`unknown session action "${action}"`);
  const status = await statusOperation(input, baseCwd);
  return { ...status, action };
}

function operationFromMethod(method) {
  if (typeof method !== "string") return null;
  if (TOOL_TO_OPERATION[method]) return TOOL_TO_OPERATION[method];
  if (OPERATION_NAMES.includes(method)) return method;
  const match = /^(?:astra[/:._-])(.+)$/.exec(method);
  return match && OPERATION_NAMES.includes(match[1]) ? match[1] : null;
}

function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function errorDetails(error) {
  if (error instanceof McpError) return { code: error.code, message: error.message, data: error.data };
  return { code: JSON_RPC_ERRORS.internal, message: "internal Astra error" };
}

function toToolResult(data) {
  const serialized = JSON.stringify(data);
  return {
    content: [{ type: "text", text: serialized }],
    structuredContent: data,
    isError: data?.ok === false,
  };
}

function serverCapabilities() {
  return { tools: { listChanged: false } };
}

function protocolResult(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params.protocolVersion ?? MCP_PROTOCOL_VERSION,
        capabilities: serverCapabilities(),
        serverInfo: MCP_SERVER_INFO,
        instructions: "Use astra_start, then astra_check before each gate transition. Gate approval requires human:true; interaction responses require resumeToken.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOL_DEFINITIONS };
    default:
      return undefined;
  }
}

/**
 * Create one request handler. Dependencies may be injected by tests or a host embedding Astra;
 * production callers only need cwd. The returned object never writes to stdout.
 */
export function createMcpServer(options = {}) {
  const baseCwd = resolve(options.cwd ?? process.cwd());
  const dependencies = {
    checkGate: options.checkGate ?? checkGate,
    runDesignGate: options.runDesignGate ?? runDesignGate,
    runExecution: options.runExecution ?? runExecution,
    startVisualizer: options.startVisualizer,
    logger: options.logger ?? (() => {}),
  };
  let closed = false;
  const visualizers = new Map();

  const callOperation = async (operation, rawParams = {}) => {
    if (closed) throw new McpError("MCP server is closed", { code: JSON_RPC_ERRORS.operation });
    const params = normalizedInput(rawParams);
    switch (operation) {
      case "start":
        return startOperation(params, baseCwd);
      case "check":
      case "status":
        return statusOperation(params, baseCwd);
      case "run":
        return runOperation(params, baseCwd, dependencies);
      case "gate":
        return gateOperation(params, baseCwd);
      case "advance":
        return advanceOperation(params, baseCwd);
      case "loop":
        return loopOperation(params, baseCwd);
      case "visualizer":
        return visualizerOperation(params, baseCwd, visualizers, dependencies.startVisualizer);
      case "approve":
        return approveOperation(params, baseCwd);
      case "respond":
        return respondOperation(params, baseCwd);
      case "complete":
        return completeOperation(params, baseCwd);
      case "session":
        return sessionOperation(params, baseCwd, server);
      default:
        throw new McpError(`unknown Astra operation "${operation}"`, { code: JSON_RPC_ERRORS.methodNotFound });
    }
  };

  const dispatch = async (method, rawParams = {}) => {
    const params = normalizedInput(rawParams);
    const builtIn = protocolResult(method, params);
    if (builtIn !== undefined) return builtIn;
    if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
    if (method === "tools/call") {
      const name = text(params.name, "name", { required: true });
      const operation = TOOL_TO_OPERATION[name];
      if (!operation) throw new McpError(`unknown tool "${name}"`, { code: JSON_RPC_ERRORS.methodNotFound });
      const args = params.arguments === undefined ? {} : normalizedInput(params.arguments);
      try {
        return toToolResult(await callOperation(operation, args));
      } catch (error) {
        const details = errorDetails(error);
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: details.message }) }],
          isError: true,
          ...(details.data === undefined ? {} : { structuredContent: { ok: false, error: details.message, details: details.data } }),
        };
      }
    }
    const operation = operationFromMethod(method);
    if (!operation) throw new McpError(`method not found: ${method}`, { code: JSON_RPC_ERRORS.methodNotFound });
    return callOperation(operation, params);
  };

  const handleRequest = async (request) => {
    if (Array.isArray(request)) {
      if (!request.length) return rpcError(null, JSON_RPC_ERRORS.invalidRequest, "empty JSON-RPC batch");
      const responses = await Promise.all(request.map((item) => handleRequest(item)));
      return responses.flatMap((response) => (response === null ? [] : [response]));
    }
    if (!isRecord(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return rpcError(request?.id ?? null, JSON_RPC_ERRORS.invalidRequest, "invalid JSON-RPC request");
    }
    const isNotification = !Object.prototype.hasOwnProperty.call(request, "id");
    try {
      const result = await dispatch(request.method, request.params);
      return isNotification ? null : { jsonrpc: "2.0", id: request.id, result };
    } catch (error) {
      if (isNotification) return null;
      const details = errorDetails(error);
      return rpcError(request.id, details.code, details.message, details.data);
    }
  };

  const server = {
    cwd: baseCwd,
    tools: TOOL_DEFINITIONS,
    callOperation,
    dispatch,
    handleRequest,
    async close() {
      closed = true;
      await Promise.all([...visualizers.values()].map((visualizer) => visualizer.close()));
      visualizers.clear();
    },
  };
  return server;
}

export const createServer = createMcpServer;

/** Handle one parsed JSON-RPC request with a fresh server. Prefer createMcpServer for a stream. */
export async function handleRequest(request, options = {}) {
  return createMcpServer(options).handleRequest(request);
}

export const handleMcpRequest = handleRequest;

function writeJson(output, value) {
  const payload = `${JSON.stringify(value)}\n`;
  output.write(payload);
}

/**
 * Run the newline-delimited MCP stdio transport. Non-protocol logs from the existing pipeline
 * are redirected to stderr for the lifetime of the server; stdout therefore contains JSON only.
 */
export async function serveStdio({ server = createMcpServer(), input = process.stdin, output = process.stdout, maxMessageBytes = MAX_MESSAGE_BYTES } = {}) {
  const { createInterface } = await import("node:readline");
  const originalOutputWrite = output.write.bind(output);
  const originalProcessWrite = process.stdout.write;
  const pending = new Set();
  const redirectStdout = output === process.stdout;
  if (redirectStdout) process.stdout.write = (...args) => process.stderr.write(...args);

  const lineReader = createInterface({ input, crlfDelay: Infinity });
  const complete = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
  };

  try {
    for await (const line of lineReader) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > maxMessageBytes) {
        originalOutputWrite(`${JSON.stringify(rpcError(null, JSON_RPC_ERRORS.parse, "JSON-RPC message exceeds size limit"))}\n`);
        continue;
      }
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        originalOutputWrite(`${JSON.stringify(rpcError(null, JSON_RPC_ERRORS.parse, "invalid JSON"))}\n`);
        continue;
      }
      const task = Promise.resolve(server.handleRequest(request)).then((response) => {
        if (response !== null && response !== undefined) {
          const payload = `${JSON.stringify(response)}\n`;
          originalOutputWrite(payload);
        }
      }).catch((error) => {
        originalOutputWrite(`${JSON.stringify(rpcError(null, JSON_RPC_ERRORS.internal, "internal Astra error"))}\n`);
        process.stderr.write(`${error?.stack ?? error}\n`);
      });
      complete(task);
    }
    await Promise.all([...pending]);
  } finally {
    lineReader.close();
    await server.close?.();
    if (redirectStdout) process.stdout.write = originalProcessWrite;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  serveStdio().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
