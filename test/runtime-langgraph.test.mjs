// The LangGraph adapter has to behave exactly like the local scheduler: same waves, same
// blocking on failed dependencies, same retry budget, same bounded concurrency.
import assert from "node:assert/strict";
import test from "node:test";
import { getRuntime } from "../lib/runtime/index.mjs";
import { runGraph as localRunGraph } from "../lib/runtime/local.mjs";

const installed = await import("@langchain/langgraph").then(
  () => true,
  () => false,
);
const langgraph = { skip: installed ? false : "@langchain/langgraph is not installed" };

const node = (id, deps, kind = "implement") => ({
  id,
  deps,
  kind,
  slice: "s1",
  title: id,
  role: { name: "r", systemPrompt: "p", writeBoundary: ["src/**"] },
});

const PLAN = {
  nodes: [node("n1", []), node("n2", ["n1"], "unit"), node("n3", [], "static"), node("n4", ["n2", "n3"], "e2e")],
};

test("langgraph runtime runs waves in dependency order", langgraph, async () => {
  const { runGraph } = getRuntime("langgraph");
  const waves = [];
  const ran = [];
  const result = await runGraph({
    plan: PLAN,
    concurrency: 4,
    maxAttempts: 2,
    hooks: { onWave: (n, total, wave) => waves.push([n, total, wave.map((w) => w.id).join("+")]) },
    execute: async (n) => {
      ran.push(n.id);
      return { ok: true, summary: `${n.id} ok`, exitCode: 0 };
    },
  });

  assert.equal(result.status, "passed");
  assert.deepEqual([...result.results.keys()].sort(), ["n1", "n2", "n3", "n4"]);
  assert.deepEqual(waves, [
    [1, 3, "n1+n3"],
    [2, 3, "n2"],
    [3, 3, "n4"],
  ]);
  assert.ok(ran.indexOf("n1") < ran.indexOf("n2"), "dependency ran first");
  assert.ok(ran.indexOf("n2") < ran.indexOf("n4"));
  assert.equal(result.results.get("n2").attempts, 1);
});

test("langgraph runtime blocks transitive dependents and retries once", langgraph, async () => {
  const { runGraph } = getRuntime("langgraph");
  const seen = [];
  const result = await runGraph({
    plan: PLAN,
    concurrency: 2,
    maxAttempts: 2,
    hooks: { onNodeBlocked: (n, dep) => seen.push(`blocked:${n.id}<-${dep}`) },
    execute: async (n) => {
      seen.push(n.id);
      return n.id === "n1" ? { ok: false, summary: "boom", exitCode: 1 } : { ok: true };
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(seen.filter((s) => s === "n1").length, 2, "failed node retried once");
  assert.ok(seen.includes("blocked:n2<-n1"));
  assert.ok(seen.includes("blocked:n4<-n2"), "blocking is transitive");
  assert.ok(seen.includes("n3"), "independent node still ran");
  assert.equal(result.results.get("n4").blocked, true);
});

test("langgraph runtime honours the concurrency cap", langgraph, async () => {
  const { runGraph } = getRuntime("langgraph");
  const wide = { nodes: ["a", "b", "c", "d", "e"].map((id) => node(id, [])) };
  let active = 0;
  let peak = 0;
  const result = await runGraph({
    plan: wide,
    concurrency: 2,
    maxAttempts: 1,
    execute: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return { ok: true };
    },
  });
  assert.equal(result.status, "passed");
  assert.equal(peak, 2, `peak concurrency was ${peak}`);
});

test("langgraph and local runtimes agree on status and per-node outcome", langgraph, async () => {
  const { runGraph } = getRuntime("langgraph");
  const script = (n) => (n.id === "n3" ? { ok: false, summary: "static failed", exitCode: 1 } : { ok: true });
  const summarise = ({ status, results }) => ({
    status,
    nodes: [...results.entries()]
      .map(([id, r]) => `${id}:${r.ok ? "ok" : r.blocked ? "blocked" : "failed"}`)
      .sort(),
  });

  const local = await localRunGraph({ plan: PLAN, concurrency: 2, maxAttempts: 1, execute: async (n) => script(n) });
  const graph = await runGraph({ plan: PLAN, concurrency: 2, maxAttempts: 1, execute: async (n) => script(n) });
  assert.deepEqual(summarise(graph), summarise(local));
});
