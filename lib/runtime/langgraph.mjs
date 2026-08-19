import { waves } from "../gates.mjs";

/**
 * LangGraph.js adapter for the Gate 5 DAG.
 *
 * The plan is compiled into a barrier/fan-out graph rather than wiring node dependencies as
 * direct edges: LangGraph triggers a node as soon as any incoming edge fires, so a node whose
 * dependencies land in different supersteps would run more than once. Barriers keep one
 * superstep per wave, which preserves the local runtime's ordering and blocking semantics while
 * still running a wave in parallel.
 *
 *   START -> wave-1 -> [nodes] -> wave-2 -> [nodes] -> ... -> END
 */
export const RUNTIME_ID = "langgraph";

export async function runGraph({ plan, execute, concurrency = 2, maxAttempts = 2, hooks = {} }) {
  const lg = await loadLangGraph();
  const { Annotation, END, START, StateGraph } = lg;

  const order = waves(plan.nodes);
  const State = Annotation.Root({
    results: Annotation({
      reducer: (a, b) => ({ ...a, ...b }),
      default: () => ({}),
    }),
  });

  const graph = new StateGraph(State);
  const gate = semaphore(concurrency);

  order.forEach((wave, index) => {
    const barrier = barrierId(index);
    graph.addNode(barrier, async () => {
      await hooks.onWave?.(index + 1, order.length, wave);
      return {};
    });
    for (const node of wave) {
      graph.addNode(node.id, async (state) => ({
        results: { [node.id]: await runNode({ node, state, execute, maxAttempts, hooks, gate }) },
      }));
      graph.addEdge(barrier, node.id);
    }
  });

  if (!order.length) {
    graph.addNode(barrierId(0), async () => ({}));
    graph.addEdge(START, barrierId(0));
    graph.addEdge(barrierId(0), END);
  } else {
    graph.addEdge(START, barrierId(0));
    order.forEach((wave, index) => {
      const next = index + 1 < order.length ? barrierId(index + 1) : END;
      for (const node of wave) graph.addEdge(node.id, next);
    });
  }

  const final = await graph.compile().invoke({}, { recursionLimit: order.length * 2 + 8 });
  const results = new Map(Object.entries(final.results ?? {}));
  const values = [...results.values()];
  const failed = values.filter((r) => !r.ok && !r.blocked);
  const blocked = values.filter((r) => r.blocked);
  const status = failed.length ? "failed" : blocked.length ? "blocked" : "passed";
  return { status, results };
}

async function runNode({ node, state, execute, maxAttempts, hooks, gate }) {
  const prior = state.results ?? {};
  const failedDep = node.deps.find((d) => prior[d] && (prior[d].ok === false || prior[d].blocked));
  if (failedDep) {
    await hooks.onNodeBlocked?.(node, failedDep);
    const blocked = { ok: false, blocked: true, summary: `blocked by ${failedDep}` };
    await hooks.onNodeEnd?.(node, blocked);
    return blocked;
  }

  const release = await gate();
  try {
    let attempt = 0;
    let result;
    while (attempt < maxAttempts) {
      attempt += 1;
      await hooks.onNodeStart?.(node, attempt);
      result = await execute(node, attempt);
      if (result.ok || result.blocked) break;
      if (attempt < maxAttempts) await hooks.onNodeRetry?.(node, attempt, result);
    }
    const final = { ...result, attempts: attempt };
    await hooks.onNodeEnd?.(node, final);
    return final;
  } finally {
    release();
  }
}

function barrierId(index) {
  return `__wave${index + 1}`;
}

/** Bounded concurrency across a wave, since LangGraph starts every branch in the superstep at once. */
function semaphore(limit) {
  const max = Math.max(1, limit);
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    queue.shift()();
  };
  return () =>
    new Promise((resolve) => {
      queue.push(() => resolve(() => {
        active -= 1;
        next();
      }));
      next();
    });
}

export async function loadLangGraph() {
  try {
    return await import("@langchain/langgraph");
  } catch (cause) {
    const err = new Error(
      'the langgraph runtime needs its peer dependency — run `npm install @langchain/langgraph` in this repo, then re-run with --runtime langgraph',
    );
    err.exitCode = 4;
    err.cause = cause;
    throw err;
  }
}
