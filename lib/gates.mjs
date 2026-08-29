import { relative } from "node:path";
import { stat } from "node:fs/promises";
import { artifact, REL } from "./paths.mjs";
import { loadSchema } from "./prompt.mjs";
import { validate } from "./validate.mjs";
import { isNonEmptyFile, readJson } from "./util.mjs";
import { validateUserStory } from "./user-story.mjs";
import { checkMaterializedUserStory } from "./user-story-materializer.mjs";

// The five gates of the Astra factory. Order is the contract; a gate cannot run before the
// previous one is cleared, and every gate is defined by the artifacts it must leave on disk.
export const GATES = [
  {
    id: "product",
    n: 1,
    name: "Product Intent & User Story",
    role: "Product Architect Agent",
    prompt: "gate1-product.md",
    artifacts: [
      { key: "product", kind: "markdown", minBytes: 400 },
      { key: "userStory", kind: "json", schema: "user-story", extra: (data, context) => validateUserStory(data, context) },
    ],
  },
  {
    id: "architecture",
    n: 2,
    name: "Architecture & Adversarial Audit",
    role: "System Designer Agent",
    prompt: "gate2-architecture.md",
    judge: true,
    artifacts: [
      { key: "architecture", kind: "markdown", minBytes: 600 },
      { key: "systemArchitecture", kind: "json", schema: "system-architecture" },
      { key: "auditJson", kind: "json", schema: "audit" },
    ],
  },
  {
    id: "design",
    n: 3,
    name: "Program Design & Contract Hardening",
    role: "Program Design Agent",
    prompt: "gate3-program-design.md",
    artifacts: [
      { key: "programDesign", kind: "markdown", minBytes: 600 },
      { key: "callStackTypes", kind: "json", schema: "call-stack-types" },
    ],
  },
  {
    id: "plan",
    n: 4,
    name: "Graph Engineering & Agent Role Allocation",
    role: "Graph Engineer Agent",
    prompt: "gate4-graph.md",
    artifacts: [
      { key: "slices", kind: "markdown", minBytes: 300 },
      { key: "plan", kind: "markdown", minBytes: 200 },
      { key: "dag", kind: "json", schema: "plan", extra: checkDag },
    ],
  },
  {
    id: "execute",
    n: 5,
    name: "Testing Trophy Execution",
    role: "Slice Workers",
    execute: true,
    artifacts: [{ key: "execution", kind: "json", schema: "dag-execution", extra: checkExecution }],
  },
];

export const GATE_IDS = GATES.map((g) => g.id);

export function getGate(id) {
  const gate = GATES.find((g) => g.id === id || String(g.n) === String(id));
  if (!gate) throw new Error(`unknown gate "${id}" — choose one of: ${GATE_IDS.join(", ")}`);
  return gate;
}

/** Gate numbers are accepted anywhere a gate id is, so `astra gate 1` and `astra gate product` agree. */
export function gateId(id) {
  return getGate(id).id;
}

export function nextGate(id) {
  const index = GATE_IDS.indexOf(id);
  return index >= 0 && index < GATES.length - 1 ? GATES[index + 1] : null;
}

/** Validate a gate purely from what is on disk. Never trust a claim that a gate ran. */
export async function checkGate(root, gateId, options = {}) {
  const gate = getGate(gateId);
  const checks = [];
  let ledger = null;
  try {
    ledger = await readJson(artifact(root, "ledger"));
  } catch {
    // Standalone artifact validation remains supported; active runs get slug binding below.
  }

  for (const spec of gate.artifacts) {
    const path = artifact(root, spec.key);
    const rel = REL[spec.key];
    if (!(await isNonEmptyFile(path))) {
      checks.push({ path: rel, ok: false, detail: "missing or empty" });
      continue;
    }

    if (spec.kind === "markdown") {
      const bytes = (await stat(path)).size;
      if (spec.minBytes && bytes < spec.minBytes) {
        checks.push({ path: rel, ok: false, detail: `${bytes} bytes — too thin to be a real document` });
        continue;
      }
      checks.push({ path: rel, ok: true, detail: `${bytes} bytes` });
      continue;
    }

    let data;
    try {
      data = await readJson(path);
    } catch (err) {
      checks.push({ path: rel, ok: false, detail: `invalid JSON: ${err.message}` });
      continue;
    }

    const schema = await loadSchema(spec.schema);
    const result = validate(schema, data);
    if (!result.ok) {
      checks.push({ path: rel, ok: false, detail: result.errors.slice(0, 4).join("; ") });
      continue;
    }
    const extra = spec.extra
      ? await spec.extra(data, { slug: options.expectedSlug ?? ledger?.meta?.slug })
      : { ok: true, detail: "schema ok" };
    checks.push({ path: rel, ok: extra.ok, detail: extra.detail });

    if (spec.key === "userStory" && options.requireMaterialization && extra.ok && data.meta.surface === "ui") {
      const materialization = await checkMaterializedUserStory(root, data);
      checks.push({
        path: REL.userStoryFig,
        ok: materialization.ok,
        detail: materialization.detail,
      });
      checks.push({ path: REL.userStoryPreview, ok: materialization.ok, detail: materialization.detail });
    }
  }

  return { gate, ok: checks.every((c) => c.ok), checks };
}

function checkDag(plan) {
  const ids = new Set(plan.nodes.map((n) => n.id));
  const problems = [];

  for (const node of plan.nodes) {
    for (const dep of node.deps) {
      if (!ids.has(dep)) problems.push(`${node.id} depends on unknown ${dep}`);
    }
  }

  const sliceIds = new Set(plan.slices.map((s) => s.id));
  for (const node of plan.nodes) {
    if (!sliceIds.has(node.slice)) problems.push(`${node.id} references unknown slice ${node.slice}`);
  }
  for (const slice of plan.slices) {
    const own = plan.nodes.filter((n) => n.slice === slice.id);
    if (!own.length) problems.push(`slice ${slice.id} has no nodes`);
    else if (own.every((n) => n.kind === "implement")) {
      problems.push(`slice ${slice.id} has no verification node`);
    }
  }
  if (!plan.slices.some((s) => s.tracer)) problems.push("no tracer slice");

  const cycle = findCycle(plan.nodes);
  if (cycle) problems.push(`dependency cycle: ${cycle.join(" -> ")}`);

  return problems.length
    ? { ok: false, detail: problems.slice(0, 4).join("; ") }
    : { ok: true, detail: `${plan.slices.length} slices, ${plan.nodes.length} nodes, acyclic` };
}

function checkExecution(state) {
  const failed = state.nodes.filter((n) => n.status === "failed");
  const unfinished = state.nodes.filter((n) => !["passed", "skipped"].includes(n.status));
  if (failed.length) return { ok: false, detail: `${failed.length} failed node(s): ${failed.map((n) => n.id).join(", ")}` };
  if (unfinished.length) return { ok: false, detail: `${unfinished.length} node(s) not finished` };
  return { ok: true, detail: `${state.nodes.length} nodes passed` };
}

export function findCycle(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map();
  const stack = [];

  const walk = (id) => {
    const mark = state.get(id);
    if (mark === "done") return null;
    if (mark === "open") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "open");
    stack.push(id);
    for (const dep of byId.get(id)?.deps ?? []) {
      const found = walk(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const node of nodes) {
    const found = walk(node.id);
    if (found) return found;
  }
  return null;
}

/** Topological waves: each wave is the set of nodes whose deps are all satisfied. */
export function waves(nodes) {
  const cycle = findCycle(nodes);
  if (cycle) throw new Error(`dependency cycle: ${cycle.join(" -> ")}`);
  const done = new Set();
  const out = [];
  let remaining = [...nodes];

  while (remaining.length) {
    const ready = remaining.filter((n) => n.deps.every((d) => done.has(d)));
    if (!ready.length) throw new Error("unsatisfiable dependencies in plan");
    out.push(ready);
    for (const node of ready) done.add(node.id);
    remaining = remaining.filter((n) => !done.has(n.id));
  }
  return out;
}

export function relPath(root, cwd) {
  return relative(cwd, root) || ".";
}
