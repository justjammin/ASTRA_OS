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
  command: typeof command === "string" ? { program: command, args: [] } : command,
});

async function runRoot(plan) {
  const cwd = await mkdtemp(join(tmpdir(), "astra-exec-"));
  const root = join(cwd, ".astra", plan.meta.slug);
  await mkdir(join(root, "json"), { recursive: true });
  await mkdir(join(root, "logs"), { recursive: true });
  await writeFile(join(root, "json", "plan.json"), JSON.stringify(plan));
  return { cwd, root };
}

const ctx = (cwd, root, sandboxConfigs = []) => ({
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
  commandSandboxFactory: async (config) => {
    sandboxConfigs.push(config);
    return {
    backend: "test-command-sandbox",
    run: async ({ program, args }) => ({
      exitCode: program === "exit" ? Number(args[0]) : 0,
      stdout: "",
      stderr: "",
    }),
    close: async () => {},
    };
  },
});

test("command nodes execute for real and the execution artifact records them", async () => {
  const plan = planWith([node("n1", "static", "true"), node("n2", "integration", "true", ["n1"])]);
  const { cwd, root } = await runRoot(plan);
  const sandboxConfigs = [];

  const result = await runExecution(ctx(cwd, root, sandboxConfigs), { log: () => {} });
  assert.equal(result.status, "passed");

  const state = JSON.parse(await readFile(join(root, "json", "dag-execution.json"), "utf8"));
  assert.equal(state.status, "passed");
  assert.deepEqual(state.nodes.map((n) => n.status), ["passed", "passed"]);
  assert.equal(state.slices[0].status, "passed");
  assert.equal(state.meta.policy.backend, "command-sandbox");
  assert.equal(state.meta.policy.profile, "dag-worker");
  assert.equal(sandboxConfigs.length, 2, "each command node gets its own sandbox");
  assert.ok(sandboxConfigs.every((config) => config.denyRead.includes(join(cwd, ".git"))));
  assert.ok(sandboxConfigs.every((config) => config.denyWrite.includes(join(cwd, ".git"))));
  assert.ok(state.events.some((e) => /wave 1\/2/.test(e.message)));
  assert.ok(state.nodes.every((n) => n.logPath.includes("logs/node-")));

  const gate = await checkGate(root, "execute");
  assert.equal(gate.ok, true);
});

test("a failing node blocks its dependents and fails the gate", async () => {
  const plan = planWith([
    node("n1", "implement", { program: "exit", args: ["3"] }),
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
  assert.equal(byId.n1.policy.backend, "test-command-sandbox");

  const gate = await checkGate(root, "execute");
  assert.equal(gate.ok, false);
  assert.match(gate.checks[0].detail, /failed node/);
});

test("agent DAG nodes receive and record their derived execution policy", async () => {
  const plan = planWith([node("n1", "implement")]);
  const { cwd, root } = await runRoot(plan);
  const calls = [];
  const result = await runExecution({
    ...ctx(cwd, root),
    invoke: async (adapter, options) => {
      calls.push({ adapter, options });
      return {
        ok: true,
        code: 0,
        stdout: "RESULT: pass",
        stderr: "",
        durationMs: 1,
        nativePolicy: { adapter, probe: { ok: true } },
      };
    },
  }, { log: () => {} });

  assert.equal(result.status, "passed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.executionPolicy.profile, "dag-worker");
  const state = JSON.parse(await readFile(join(root, "json", "dag-execution.json"), "utf8"));
  assert.equal(state.nodes[0].policy.profile, "dag-worker");
  assert.equal(state.nodes[0].policy.backend, "claude");
});
