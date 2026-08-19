import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runExecution } from "../lib/pipeline.mjs";
import { checkGate } from "../lib/gates.mjs";

function planWith(nodes) {
  return {
    meta: { slug: "exec-demo", intent: "run the graph", agent: "claude" },
    slices: [
      { id: "s1", title: "Tracer slice", demo: "watch it run", tracer: true, criteria: ["passes"], nodes: nodes.map((n) => n.id) },
    ],
    nodes,
  };
}

const node = (id, kind, command, deps = []) => ({
  id,
  title: `${kind} ${id}`,
  slice: "s1",
  kind,
  deps,
  role: { name: `${kind}-worker`, systemPrompt: "verify only", writeBoundary: ["src/thing.ts"] },
  command,
});

async function runRoot(plan) {
  const cwd = await mkdtemp(join(tmpdir(), "astra-exec-"));
  const root = join(cwd, ".astra", plan.meta.slug);
  await mkdir(join(root, "json"), { recursive: true });
  await mkdir(join(root, "logs"), { recursive: true });
  await writeFile(join(root, "json", "plan.json"), JSON.stringify(plan));
  return { cwd, root };
}

const ctx = (cwd, root) => ({
  cwd,
  root,
  slug: "exec-demo",
  intent: "run the graph",
  agent: "claude",
  judge: "solo",
  runtime: "local",
  concurrency: 2,
  maxAttempts: 1,
  specialists: false,
});

test("command nodes execute for real and the execution artifact records them", async () => {
  const plan = planWith([node("n1", "static", "true"), node("n2", "integration", "true", ["n1"])]);
  const { cwd, root } = await runRoot(plan);

  const result = await runExecution(ctx(cwd, root), { log: () => {} });
  assert.equal(result.status, "passed");

  const state = JSON.parse(await readFile(join(root, "json", "dag-execution.json"), "utf8"));
  assert.equal(state.status, "passed");
  assert.deepEqual(state.nodes.map((n) => n.status), ["passed", "passed"]);
  assert.equal(state.slices[0].status, "passed");
  assert.ok(state.events.some((e) => /wave 1\/2/.test(e.message)));
  assert.ok(state.nodes.every((n) => n.logPath.includes("logs/node-")));

  const gate = await checkGate(root, "execute");
  assert.equal(gate.ok, true);
});

test("a failing node blocks its dependents and fails the gate", async () => {
  const plan = planWith([
    node("n1", "implement", "exit 3"),
    node("n2", "unit", "true", ["n1"]),
    node("n3", "static", "true"),
  ]);
  const { cwd, root } = await runRoot(plan);

  const result = await runExecution(ctx(cwd, root), { log: () => {} });
  assert.equal(result.status, "failed");

  const state = JSON.parse(await readFile(join(root, "json", "dag-execution.json"), "utf8"));
  const byId = Object.fromEntries(state.nodes.map((n) => [n.id, n]));
  assert.equal(byId.n1.status, "failed");
  assert.equal(byId.n1.exitCode, 3);
  assert.equal(byId.n2.status, "blocked");
  assert.equal(byId.n3.status, "passed", "independent node still runs");

  const gate = await checkGate(root, "execute");
  assert.equal(gate.ok, false);
  assert.match(gate.checks[0].detail, /failed node/);
});
