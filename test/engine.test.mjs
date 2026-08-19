import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validate } from "../lib/validate.mjs";
import { checkGate, findCycle, gateId, waves } from "../lib/gates.mjs";
import { advance, emptyLedger, loop, markCleared, LOOP_BUDGET } from "../lib/ledger.mjs";
import { resolve as resolveAudit } from "../lib/tribunal.mjs";
import { outOfBounds, sliceOnly } from "../lib/pipeline.mjs";
import { classify, parseFrontmatter, scan } from "../lib/rolemap.mjs";
import { loadSchema } from "../lib/prompt.mjs";
import { runGraph } from "../lib/runtime/local.mjs";
import { getRuntime } from "../lib/runtime/index.mjs";

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "astra-test-"));
  await mkdir(join(root, "json"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  return root;
}

const PLAN = {
  meta: { slug: "demo", intent: "demo intent", agent: "claude" },
  slices: [{ id: "s1", title: "Tracer", demo: "see it work", tracer: true, criteria: ["works"], nodes: ["n1", "n2"] }],
  nodes: [
    {
      id: "n1",
      title: "implement thing",
      slice: "s1",
      kind: "implement",
      deps: [],
      role: { name: "impl", systemPrompt: "own src/thing.ts", writeBoundary: ["src/thing.ts"] },
    },
    {
      id: "n2",
      title: "integration",
      slice: "s1",
      kind: "integration",
      deps: ["n1"],
      role: { name: "int", systemPrompt: "verify", writeBoundary: ["test/thing.test.ts"] },
      command: "true",
    },
  ],
};

test("validate enforces required keys, enums, and patterns", async () => {
  const schema = await loadSchema("plan");
  assert.equal(validate(schema, PLAN).ok, true);

  const bad = structuredClone(PLAN);
  bad.nodes[0].kind = "vibes";
  assert.match(validate(schema, bad).errors.join(" "), /not in \[implement/);

  const missing = structuredClone(PLAN);
  delete missing.slices;
  assert.match(validate(schema, missing).errors.join(" "), /missing required "slices"/);

  const extra = structuredClone(PLAN);
  extra.nodes[0].surprise = 1;
  assert.match(validate(schema, extra).errors.join(" "), /unexpected property "surprise"/);
});

test("waves order nodes by dependency and detect cycles", () => {
  const order = waves(PLAN.nodes);
  assert.deepEqual(order.map((w) => w.map((n) => n.id)), [["n1"], ["n2"]]);

  const cyclic = [
    { id: "n1", deps: ["n2"] },
    { id: "n2", deps: ["n1"] },
  ];
  assert.ok(findCycle(cyclic));
  assert.throws(() => waves(cyclic), /cycle/);
});

test("checkGate reads the filesystem, not claims", async () => {
  const root = await fixtureRoot();
  const empty = await checkGate(root, "product");
  assert.equal(empty.ok, false);
  assert.match(empty.checks[0].detail, /missing or empty/);

  await writeFile(join(root, "docs", "01-product.md"), "x".repeat(500));
  await writeFile(
    join(root, "json", "ui-layout.json"),
    JSON.stringify({
      meta: { slug: "demo", intent: "demo" },
      screens: [{ id: "u1", name: "Home", purpose: "land", elements: [{ type: "heading", label: "Hi" }] }],
    }),
  );
  const good = await checkGate(root, "product");
  assert.equal(good.ok, true);

  await writeFile(join(root, "json", "ui-layout.json"), "{not json");
  const broken = await checkGate(root, "product");
  assert.equal(broken.ok, false);
  assert.match(broken.checks[1].detail, /invalid JSON/);
});

test("checkGate rejects a plan whose slice has no verification node", async () => {
  const root = await fixtureRoot();
  const plan = structuredClone(PLAN);
  plan.nodes = [plan.nodes[0]];
  plan.slices[0].nodes = ["n1"];
  await writeFile(join(root, "docs", "04-slices.md"), "s".repeat(400));
  await writeFile(join(root, "PLAN.md"), "p".repeat(300));
  await writeFile(join(root, "json", "plan.json"), JSON.stringify(plan));

  const result = await checkGate(root, "plan");
  assert.equal(result.ok, false);
  assert.match(result.checks.at(-1).detail, /no verification node/);
});

test("ledger refuses to advance an unclear gate and enforces the loop budget", () => {
  let ledger = emptyLedger({ slug: "demo", intent: "i", agent: "claude", judge: "solo", runRoot: "/tmp/x", cwd: "/tmp" });
  assert.throws(() => advance(ledger), (err) => err.exitCode === 3);

  ledger = markCleared(ledger, "product");
  ledger = advance(ledger);
  assert.equal(ledger.phase, "architecture");

  assert.throws(() => loop(ledger, "execute", "nope"), (err) => err.exitCode === 3);

  for (let i = 0; i < LOOP_BUDGET; i++) {
    ledger = loop(ledger, "product", `pass ${i}`);
    ledger = markCleared(ledger, "product");
    ledger = advance(ledger);
  }
  assert.throws(() => loop(ledger, "product", "one too many"), (err) => err.exitCode === 2);
});

test("looping back reopens every later gate", () => {
  let ledger = emptyLedger({ slug: "d", intent: "i", agent: "claude", judge: "solo", runRoot: "/tmp/x", cwd: "/tmp" });
  ledger = markCleared(ledger, "product");
  ledger = advance(ledger);
  ledger = markCleared(ledger, "architecture");
  ledger = loop(ledger, "product", "intent changed");
  assert.equal(ledger.gates.architecture.status, "pending");
  assert.equal(ledger.phase, "product");
});

test("audit resolution is arithmetic: one P0 rejects regardless of declared verdicts", () => {
  const audit = resolveAudit(
    [
      { name: "Melchior", verdict: "approve", confidence: "high", findings: [{ severity: "P0", claim: "lost write" }] },
      { name: "Balthasar", verdict: "approve", confidence: "high", findings: [] },
      { name: "Casper", verdict: "approve", confidence: "high", findings: [] },
    ],
    { mode: "magi", slug: "demo", agent: "claude" },
  );
  assert.equal(audit.verdict, "reject");

  const split = resolveAudit(
    [
      { name: "Grunt", verdict: "revise", confidence: "high", findings: [{ severity: "P1", claim: "no breaker" }] },
      { name: "Melchior", verdict: "approve", confidence: "high", findings: [] },
    ],
    { mode: "magi", slug: "demo", agent: "claude" },
  );
  assert.equal(split.verdict, "revise");
  assert.equal(split.confidence, "med");
  assert.match(split.dissent, /Melchior voted approve/);

  const clean = resolveAudit(
    [{ name: "Grunt", verdict: "approve", confidence: "high", findings: [{ severity: "P2", claim: "naming" }] }],
    { mode: "solo", slug: "demo", agent: "claude" },
  );
  assert.equal(clean.verdict, "approve");
});

test("write boundary detection flags fresh files outside the boundary", () => {
  const before = new Set(["src/existing.ts"]);
  const after = new Set(["src/existing.ts", "src/thing.ts", "src/sneaky.ts", ".astra/demo/json/plan.json", "test/a/b.test.ts"]);
  const violations = outOfBounds(before, after, ["src/thing.ts", "test/a"]);
  assert.deepEqual(violations, ["src/sneaky.ts"]);

  assert.deepEqual(outOfBounds(before, after, ["src/*.ts", "test/a"]), []);
  assert.deepEqual(outOfBounds(null, after, ["src/thing.ts"]), []);
});

test("local runtime blocks dependents instead of failing the whole graph", async () => {
  const plan = {
    nodes: [
      { id: "n1", deps: [], kind: "implement", slice: "s1", title: "a", role: { name: "r", systemPrompt: "p", writeBoundary: ["x"] } },
      { id: "n2", deps: ["n1"], kind: "unit", slice: "s1", title: "b", role: { name: "r", systemPrompt: "p", writeBoundary: ["x"] } },
      { id: "n3", deps: [], kind: "static", slice: "s1", title: "c", role: { name: "r", systemPrompt: "p", writeBoundary: ["x"] } },
    ],
  };
  const seen = [];
  const result = await runGraph({
    plan,
    concurrency: 2,
    maxAttempts: 2,
    execute: async (node) => {
      seen.push(node.id);
      return node.id === "n1" ? { ok: false, summary: "boom" } : { ok: true };
    },
    hooks: { onNodeBlocked: (node) => seen.push(`blocked:${node.id}`) },
  });
  assert.equal(result.status, "failed");
  assert.equal(seen.filter((s) => s === "n1").length, 2, "failed node retried once");
  assert.ok(seen.includes("blocked:n2"));
  assert.ok(seen.includes("n3"), "independent node still ran");
});

test("slice filter keeps one slice and drops outside deps", () => {
  const plan = {
    meta: { slug: "x" },
    slices: [
      { id: "s1", title: "Tracer", tracer: true, nodes: ["n1", "n2"] },
      { id: "s2", title: "Second", tracer: false, nodes: ["n3"] },
    ],
    nodes: [
      { id: "n1", slice: "s1", deps: [] },
      { id: "n2", slice: "s1", deps: ["n1"] },
      { id: "n3", slice: "s2", deps: ["n2"] },
    ],
  };

  const tracer = sliceOnly(plan, "tracer");
  assert.deepEqual(tracer.slices.map((s) => s.id), ["s1"]);
  assert.deepEqual(tracer.nodes.map((n) => n.id), ["n1", "n2"]);
  assert.equal(tracer.meta.sliceFilter, "s1");

  const second = sliceOnly(plan, "s2");
  assert.deepEqual(second.nodes, [{ id: "n3", slice: "s2", deps: [] }], "dep outside the slice is dropped");
  assert.throws(() => sliceOnly(plan, "s9"), /no slice "s9"/);
});

test("gates resolve by number as well as id", () => {
  assert.equal(gateId("1"), "product");
  assert.equal(gateId(5), "execute");
  assert.equal(gateId("execute"), "execute");
  assert.throws(() => gateId("6"), /unknown gate/);
});

test("runtime registry exposes local and langgraph", () => {
  assert.equal(getRuntime().id, "local");
  assert.equal(getRuntime("langgraph").id, "langgraph");
  assert.equal(typeof getRuntime("langgraph").runGraph, "function");
  assert.throws(() => getRuntime("nope"), /unknown runtime/);
});

test("frontmatter parsing, classification, and scan produce a lean map", async () => {
  const { data, body } = parseFrontmatter("---\nname: astra-x\ndescription: does a thing\n---\nBody text\n");
  assert.equal(data.name, "astra-x");
  assert.equal(body.trim(), "Body text");
  assert.equal(parseFrontmatter("no frontmatter").data.name, undefined);

  assert.equal(classify("design a REST endpoint for the billing service"), "backend");
  assert.equal(classify("write playwright coverage"), "testing");

  const roots = await mkdtemp(join(tmpdir(), "astra-roles-"));
  await writeFile(join(roots, "sql-pro.md"), "---\nname: sql-pro\ndescription: postgres query and migration expert\n---\nbody\n");
  await writeFile(join(roots, "skip.md"), "no frontmatter here\n");
  const mapDir = await mkdtemp(join(tmpdir(), "astra-map-"));

  const result = await scan({ roots: [roots], mapDir, includeVendored: false });
  assert.equal(result.count, 1);
  assert.deepEqual(result.index.domains.data, ["sql-pro"]);
});
