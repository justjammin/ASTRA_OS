import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginWorker,
  budgetSnapshot,
  finishWorker,
  initializeSession,
  loadSession,
  recordUsage,
} from "../lib/broker.mjs";

test("budget snapshot reports visible calculations and compaction threshold", () => {
  assert.deepEqual(budgetSnapshot(500, 1000), {
    usedTokens: 500,
    budgetTokens: 1000,
    remainingTokens: 500,
    percent: 50,
    compressionThreshold: 0.5,
    compressionSuggested: true,
  });
  assert.equal(budgetSnapshot(25).percent, null);
});

test("broker persists session, workers, and normalized usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "astra-broker-"));
  await initializeSession(root, { slug: "demo", harness: "codex", budgetTokens: 10_000 });
  await recordUsage(root, { inputTokens: 600, outputTokens: 400, sessionId: "thread-1" });
  const workerId = await beginWorker(root, { kind: "scout", harness: "codex", model: "gpt-5.6-luna", effort: "max", task: "inspect" });
  await finishWorker(root, workerId, { ok: true, sessionId: "thread-2", usage: { inputTokens: 200, outputTokens: 100 } });
  const session = await loadSession(root);
  assert.equal(session.coordinator.sessionId, "thread-1");
  assert.equal(session.budget.usedTokens, 1300);
  assert.equal(session.budget.percent, 13);
  assert.equal(session.workers[0].status, "complete");
});

test("parallel workers serialize broker mutations without losing records", async () => {
  const root = await mkdtemp(join(tmpdir(), "astra-broker-parallel-"));
  await initializeSession(root, { slug: "magi", harness: "claude" });
  await Promise.all(["melchior", "balthasar", "casper"].map((kind) =>
    beginWorker(root, { kind, harness: "claude", task: "judge" })));
  const session = await loadSession(root);
  assert.deepEqual(session.workers.map((worker) => worker.kind).sort(), ["balthasar", "casper", "melchior"]);
});
