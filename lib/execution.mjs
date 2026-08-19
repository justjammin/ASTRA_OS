import { artifact, REL } from "./paths.mjs";
import { nowIso, writeJson } from "./util.mjs";

/**
 * Live Gate 5 state. Every transition is flushed to json/dag-execution.json, which is what the
 * visualizer streams; the file is the only execution record, so nothing is held in memory alone.
 */
export function createExecution(root, plan, { agent, concurrency, runtime }) {
  const state = {
    meta: {
      slug: plan.meta.slug,
      intent: plan.meta.intent,
      agent,
      startedAt: nowIso(),
      updatedAt: nowIso(),
      concurrency,
      ...(runtime ? { runtime } : {}),
      ...(plan.meta.sliceFilter ? { sliceFilter: plan.meta.sliceFilter } : {}),
    },
    status: "running",
    nodes: plan.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      kind: node.kind,
      slice: node.slice,
      role: node.role.name,
      deps: node.deps,
      status: "pending",
      attempts: 0,
    })),
    slices: plan.slices.map((slice) => ({
      id: slice.id,
      title: slice.title,
      tracer: Boolean(slice.tracer),
      status: "pending",
    })),
    events: [],
  };

  const path = artifact(root, "execution");
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  let queued = null;

  const flush = async () => {
    state.meta.updatedAt = nowIso();
    rollUpSlices(state);
    await writeJson(path, state);
  };

  const schedule = () => {
    if (queued) return queued;
    queued = flush().finally(() => {
      queued = null;
    });
    return queued;
  };

  return {
    state,
    path,
    relPath: REL.execution,
    node: (id) => byId.get(id),
    async update(id, patch) {
      Object.assign(byId.get(id), patch);
      await schedule();
    },
    async event(level, message, node) {
      state.events.push({ ts: nowIso(), level, message: String(message).slice(0, 500), ...(node ? { node } : {}) });
      if (state.events.length > 500) state.events.splice(0, state.events.length - 500);
      await schedule();
    },
    async finish() {
      const failed = state.nodes.some((n) => n.status === "failed");
      const blocked = state.nodes.some((n) => n.status === "blocked");
      state.status = failed ? "failed" : blocked ? "blocked" : "passed";
      state.meta.finishedAt = nowIso();
      await flush();
      return state.status;
    },
    flush,
  };
}

function rollUpSlices(state) {
  for (const slice of state.slices) {
    const nodes = state.nodes.filter((n) => n.slice === slice.id);
    if (nodes.some((n) => n.status === "failed")) slice.status = "failed";
    else if (nodes.some((n) => n.status === "blocked")) slice.status = "blocked";
    else if (nodes.length && nodes.every((n) => ["passed", "skipped"].includes(n.status))) slice.status = "passed";
    else if (nodes.some((n) => n.status === "running")) slice.status = "running";
    else slice.status = "pending";
  }
}
