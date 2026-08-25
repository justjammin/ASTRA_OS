import { test } from "node:test";
import assert from "node:assert/strict";

import { getAdapter, invoke } from "../lib/adapters.mjs";

test("Codex receives prompts through stdin", async () => {
  const spec = getAdapter("codex").build({ prompt: "do work", role: "worker" });
  assert.deepEqual(spec.argv, ["exec", "--json", "-"]);
  assert.equal(spec.stdin, "worker\n\n---\n\ndo work");

  const result = await invoke("codex", {
    prompt: "do work",
    cwd: process.cwd(),
    dryRun: true,
    model: "gpt-5",
    sessionKey: "coordinator",
  });
  assert.deepEqual(result.argv, ["codex", "exec", "--model", "gpt-5", "--json", "-"]);
  assert.equal(result.stdin, "do work");
  assert.equal(result.sessionId, "coordinator");
  assert.equal(result.requestedModel, "gpt-5");
});

test("worker model and effort requests are passed to supported harnesses", async () => {
  const codex = await invoke("codex", {
    prompt: "verify",
    cwd: process.cwd(),
    dryRun: true,
    model: "gpt-5.6-luna",
    effort: "max",
  });
  assert.deepEqual(codex.argv, [
    "codex", "exec", "--model", "gpt-5.6-luna", "-c", 'model_reasoning_effort="max"', "--json", "-",
  ]);
  const claude = await invoke("claude", {
    prompt: "inspect",
    cwd: process.cwd(),
    dryRun: true,
    model: "claude-sonnet-5",
    effort: "medium",
  });
  assert.match(claude.argv.join(" "), /--model claude-sonnet-5 --effort medium/);
});
