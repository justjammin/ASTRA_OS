import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { exists, nowIso, readJson, writeJson } from "./util.mjs";
import { calculateBudget, normalizeUsage } from "./usage.mjs";

/** The six backends share this durable record shape. */
export const SESSION_BACKENDS = Object.freeze(["claude", "droid", "codex", "opencode", "hermes", "pi"]);

export const SESSION_SCHEMA_VERSION = "1.0";

/**
 * Create a durable session record.  Persistence is opt-in through `root`,
 * `sessionPath`, or `sessionDir`, which keeps library use side-effect free in
 * tests and lets the CLI choose its artifact directory explicitly.
 */
export async function createSession(adapterId, opts = {}) {
  assertBackend(adapterId);
  const now = nowIso();
  const models = resolveModels(opts);
  const usage = normalizeUsage(opts.usage ?? opts.rawUsage ?? opts.response?.usage);
  const record = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: String(opts.id ?? opts.sessionId ?? opts.sessionKey ?? randomUUID()),
    backend: adapterId,
    requestedModel: models.requestedModel,
    effectiveModel: models.effectiveModel,
    warning: models.warning,
    warnings: models.warning ? [models.warning] : [],
    usage,
    budget: calculateBudget({
      usedTokens: usage.totalTokens,
      budgetTokens: opts.budgetTokens,
      contextWindow: opts.contextWindow ?? opts.modelContextWindow,
    }),
    status: "ready",
    createdAt: now,
    updatedAt: now,
    resumeCount: 0,
    compactCount: 0,
    lastResumedAt: null,
    lastCompactedAt: null,
  };

  await persistRecord(record, opts);
  return record;
}

/**
 * Re-open a session without changing its durable id.  An optional `run`
 * callback can bridge to a real CLI/SDK; the callback is deliberately injected
 * so the record contract remains testable without installed agent binaries.
 */
export async function resumeSession(adapterId, session, opts = {}) {
  assertBackend(adapterId);
  const current = await resolveRecord(session, opts, adapterId);
  const now = nowIso();
  const models = resolveModels({ ...current, ...opts, requestedModel: opts.requestedModel ?? current.requestedModel });
  const operation = await runOperation("resume", adapterId, current, opts);
  const next = applyOperation(current, {
    ...opts,
    ...operation,
    models,
    now,
    action: "resume",
  });
  await persistRecord(next, opts);
  return next;
}

/**
 * Record a compaction boundary and its usage.  Compaction usage is additive:
 * the summary call is real provider spend and belongs in the durable total.
 */
export async function compactSession(adapterId, session, opts = {}) {
  assertBackend(adapterId);
  const current = await resolveRecord(session, opts, adapterId);
  const now = nowIso();
  const models = resolveModels({ ...current, ...opts, requestedModel: opts.requestedModel ?? current.requestedModel });
  const operation = await runOperation("compact", adapterId, current, opts);
  const next = applyOperation(current, {
    ...opts,
    ...operation,
    models,
    now,
    action: "compact",
  });
  await persistRecord(next, opts);
  return next;
}

/** Read a previously persisted record. */
export async function loadSession(sessionPath) {
  if (!sessionPath || !(await exists(sessionPath))) return null;
  return readJson(sessionPath);
}

function applyOperation(current, input) {
  const operationUsage = normalizeUsage(
    input.usage ?? input.rawUsage ?? input.response?.usage ?? input.result?.usage,
  );
  const hasOperationUsage = input.usage !== undefined || input.rawUsage !== undefined ||
    input.response?.usage !== undefined || input.result?.usage !== undefined;
  const usage = hasOperationUsage ? addUsage(current.usage, operationUsage) : normalizeUsage(current.usage);
  const warning = input.models.warning ?? current.warning ?? null;
  const warnings = uniqueWarnings([...(current.warnings ?? []), warning, input.warning, input.result?.warning]);
  const next = {
    ...current,
    backend: current.backend,
    requestedModel: input.models.requestedModel,
    effectiveModel: input.models.effectiveModel,
    warning: warning ?? warnings[0] ?? null,
    warnings,
    usage,
    budget: calculateBudget({
      usedTokens: usage.totalTokens,
      budgetTokens: input.budgetTokens ?? current.budget?.budgetTokens,
      contextWindow: input.contextWindow ?? input.modelContextWindow ?? current.budget?.contextWindow,
    }),
    status: "ready",
    updatedAt: input.now,
    ...(input.action === "resume"
      ? { resumeCount: (current.resumeCount ?? 0) + 1, lastResumedAt: input.now }
      : { compactCount: (current.compactCount ?? 0) + 1, lastCompactedAt: input.now }),
  };
  if (input.id) next.id = String(input.id);
  if (input.sessionId) next.id = String(input.sessionId);
  if (input.result !== undefined) next.lastResult = serializableResult(input.result);
  return next;
}

async function resolveRecord(session, opts, adapterId) {
  if (typeof session === "string") {
    const path = sessionPath(opts) ?? (session.includes("/") || session.endsWith(".json") ? session : null);
    const persisted = path ? await loadSession(path) : null;
    if (persisted) return validateRecord(persisted, adapterId);
    return validateRecord({ id: session, backend: adapterId, usage: normalizeUsage() }, adapterId);
  }
  if (session && typeof session === "object") return validateRecord(session, adapterId);
  const path = sessionPath(opts);
  if (path) {
    const persisted = await loadSession(path);
    if (persisted) return validateRecord(persisted, adapterId);
  }
  throw new TypeError("session record or session id is required");
}

async function runOperation(action, adapterId, session, opts) {
  const runner = opts.run ?? opts.invoke ?? opts.executor;
  if (typeof runner !== "function") return {};
  const result = await runner({ action, adapterId, session, ...opts });
  return result && typeof result === "object" ? result : { result };
}

async function persistRecord(record, opts) {
  const path = sessionPath(opts);
  if (path) await writeJson(path, record);
}

function sessionPath(opts = {}) {
  if (opts.sessionPath ?? opts.sessionFile ?? opts.path) {
    return opts.sessionPath ?? opts.sessionFile ?? opts.path;
  }
  if (opts.root) return join(opts.root, "session.json");
  if (opts.sessionDir) return join(opts.sessionDir, `${String(opts.id ?? opts.sessionId ?? opts.sessionKey ?? "session")}.json`);
  return null;
}

function resolveModels(opts) {
  const requestedModel = modelName(opts.requestedModel ?? opts.model);
  const available = Array.isArray(opts.availableModels)
    ? opts.availableModels.map(modelName).filter(Boolean)
    : null;
  let effectiveModel = modelName(opts.effectiveModel ?? opts.resolvedModel);
  if (!effectiveModel && requestedModel && (!available || available.includes(requestedModel))) {
    effectiveModel = requestedModel;
  }
  if (!effectiveModel && available?.length) effectiveModel = modelName(opts.fallbackModel) ?? available[0];
  const warning = firstWarning(
    opts.warning,
    opts.modelFallbackMessage,
    requestedModel && effectiveModel && requestedModel !== effectiveModel
      ? `Model fallback: requested "${requestedModel}", using "${effectiveModel}".`
      : null,
  );
  return { requestedModel: requestedModel ?? null, effectiveModel: effectiveModel ?? null, warning };
}

function modelName(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  if (typeof value.id === "string" && value.provider) return `${value.provider}/${value.id}`;
  return modelName(value.id ?? value.model ?? value.name);
}

function addUsage(left, right) {
  const a = normalizeUsage(left);
  const b = normalizeUsage(right);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function validateRecord(record, adapterId) {
  if (!record || typeof record !== "object") throw new TypeError("invalid session record");
  if (record.backend && record.backend !== adapterId) {
    throw new Error(`session backend mismatch: expected ${adapterId}, got ${record.backend}`);
  }
  return {
    ...record,
    id: String(record.id ?? randomUUID()),
    backend: adapterId,
    requestedModel: modelName(record.requestedModel),
    effectiveModel: modelName(record.effectiveModel),
    warning: record.warning ?? null,
    warnings: uniqueWarnings([...(record.warnings ?? []), record.warning]),
    usage: normalizeUsage(record.usage),
    resumeCount: Number.isInteger(record.resumeCount) ? record.resumeCount : 0,
    compactCount: Number.isInteger(record.compactCount) ? record.compactCount : 0,
  };
}

function serializableResult(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { value: String(value) };
  }
}

function firstWarning(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const warning = value.find((item) => typeof item === "string" && item.trim());
      if (warning) return warning.trim();
    }
  }
  return null;
}

function uniqueWarnings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function assertBackend(adapterId) {
  if (!SESSION_BACKENDS.includes(adapterId)) {
    throw new Error(`unknown agent "${adapterId}" — choose one of: ${SESSION_BACKENDS.join(", ")}`);
  }
}
