import { randomUUID } from "node:crypto";
import { artifact } from "./paths.mjs";
import { exists, nowIso, readJson, writeJson } from "./util.mjs";

export const COMPACTION_THRESHOLD = 0.5;
const MUTATION_QUEUES = new Map();

export const WORKER_MODELS = Object.freeze({
  claude: { model: "claude-sonnet-5", effort: "medium" },
  codex: { model: "gpt-5.6-luna", effort: "max" },
  droid: { model: "gpt-5.6-luna", effort: "max" },
  opencode: { model: null, effort: null },
  hermes: { model: null, effort: null },
  pi: { model: null, effort: null },
});

export function budgetSnapshot(usedTokens = 0, budgetTokens = null) {
  const used = Math.max(0, Number(usedTokens) || 0);
  const budget = Number.isFinite(Number(budgetTokens)) && Number(budgetTokens) > 0
    ? Math.floor(Number(budgetTokens))
    : null;
  const remaining = budget === null ? null : Math.max(0, budget - used);
  const percent = budget === null ? null : Math.min(100, (used / budget) * 100);
  return {
    usedTokens: used,
    budgetTokens: budget,
    remainingTokens: remaining,
    percent,
    compressionThreshold: COMPACTION_THRESHOLD,
    compressionSuggested: percent !== null && percent >= COMPACTION_THRESHOLD * 100,
  };
}

export function newSession({ slug, harness, budgetTokens = null, interfaceMode = "gui", transport = "cli" }) {
  const timestamp = nowIso();
  return {
    schemaVersion: "1.0",
    id: randomUUID(),
    slug,
    harness,
    interface: interfaceMode,
    transport,
    status: "ready",
    startedAt: timestamp,
    updatedAt: timestamp,
    coordinator: { harness, sessionId: null, status: "ready", turns: 0 },
    budget: budgetSnapshot(0, budgetTokens),
    workers: [],
    warnings: [],
  };
}

export async function initializeSession(root, options) {
  const session = newSession(options);
  await writeJson(artifact(root, "session"), session);
  return session;
}

export async function loadSession(root) {
  const path = artifact(root, "session");
  return (await exists(path)) ? readJson(path) : null;
}

export async function mutateSession(root, mutate) {
  const previous = MUTATION_QUEUES.get(root) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const session = await loadSession(root);
    if (!session) return null;
    const next = (await mutate(session)) ?? session;
    next.updatedAt = nowIso();
    next.budget = budgetSnapshot(next.budget?.usedTokens, next.budget?.budgetTokens);
    await writeJson(artifact(root, "session"), next);
    return next;
  });
  MUTATION_QUEUES.set(root, operation);
  try {
    return await operation;
  } finally {
    if (MUTATION_QUEUES.get(root) === operation) MUTATION_QUEUES.delete(root);
  }
}

export async function recordUsage(root, usage = {}) {
  return mutateSession(root, (session) => {
    const input = Math.max(0, Number(usage.inputTokens) || 0);
    const output = Math.max(0, Number(usage.outputTokens) || 0);
    session.budget.usedTokens += input + output;
    session.coordinator.turns += 1;
    if (usage.sessionId) session.coordinator.sessionId = usage.sessionId;
    if (usage.warning && !session.warnings.includes(usage.warning)) session.warnings.push(usage.warning);
  });
}

export async function beginWorker(root, { id = randomUUID(), kind, harness, model, effort, task }) {
  await mutateSession(root, (session) => {
    session.workers.push({ id, kind, harness, model, effort, task, status: "running", startedAt: nowIso() });
  });
  return id;
}

export async function finishWorker(root, id, result = {}) {
  return mutateSession(root, (session) => {
    const worker = session.workers.find((item) => item.id === id);
    if (!worker) return;
    Object.assign(worker, {
      status: result.ok === false ? "failed" : "complete",
      finishedAt: nowIso(),
      sessionId: result.sessionId ?? worker.sessionId ?? null,
      usage: result.usage ?? worker.usage ?? null,
      warning: result.warning ?? worker.warning ?? null,
    });
    const input = Math.max(0, Number(result.usage?.inputTokens) || 0);
    const output = Math.max(0, Number(result.usage?.outputTokens) || 0);
    session.budget.usedTokens += input + output;
    if (result.warning && !session.warnings.includes(result.warning)) session.warnings.push(result.warning);
  });
}
