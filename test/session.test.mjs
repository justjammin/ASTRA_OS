import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compactSession, createSession, loadSession, resumeSession } from "../lib/session.mjs";

test("all backends create the same durable session contract", async () => {
  for (const backend of ["claude", "droid", "codex", "opencode", "hermes", "pi"]) {
    const session = await createSession(backend, { requestedModel: "requested" });
    assert.equal(session.backend, backend);
    assert.equal(typeof session.id, "string");
    assert.equal(session.requestedModel, "requested");
    assert.equal(session.effectiveModel, "requested");
    assert.equal(session.warning, null);
    assert.equal(session.usage.totalTokens, 0);
  }
});

test("sessions persist, resume by id, and add compaction usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "astra-session-"));
  const created = await createSession("claude", {
    root,
    requestedModel: "missing",
    availableModels: ["fallback"],
    fallbackModel: "fallback",
    usage: { inputTokens: 2, outputTokens: 3 },
    budgetTokens: 20,
  });
  assert.match(created.warning, /missing/);
  assert.equal((await loadSession(join(root, "session.json"))).id, created.id);

  const resumed = await resumeSession("claude", created, {
    root,
    usage: { inputTokens: 1, outputTokens: 1 },
    run: async ({ action }) => {
      assert.equal(action, "resume");
      return { warning: "resumed" };
    },
  });
  assert.equal(resumed.id, created.id);
  assert.equal(resumed.resumeCount, 1);
  assert.equal(resumed.usage.totalTokens, 7);
  assert.ok(resumed.warnings.includes("resumed"));

  const compacted = await compactSession("claude", resumed, {
    root,
    usage: { inputTokens: 1, outputTokens: 2 },
  });
  assert.equal(compacted.compactCount, 1);
  assert.equal(compacted.usage.totalTokens, 10);
  assert.equal(JSON.parse(await readFile(join(root, "session.json"), "utf8")).id, created.id);
});
