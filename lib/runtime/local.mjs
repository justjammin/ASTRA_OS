import { waves } from "../gates.mjs";

/**
 * In-process wave scheduler. Nodes whose dependencies all passed run together up to
 * `concurrency`; a failed node blocks its transitive dependents instead of failing the whole
 * graph, so one bad slice cannot hide the state of the others.
 */
export async function runGraph({ plan, execute, concurrency = 2, maxAttempts = 2, hooks = {} }) {
  const order = waves(plan.nodes);
  const results = new Map();
  const blocked = new Set();

  for (const [index, wave] of order.entries()) {
    await hooks.onWave?.(index + 1, order.length, wave);
    const runnable = [];

    for (const node of wave) {
      const failedDep = node.deps.find((d) => results.get(d)?.ok === false || blocked.has(d));
      if (failedDep) {
        blocked.add(node.id);
        results.set(node.id, { ok: false, blocked: true, summary: `blocked by ${failedDep}` });
        await hooks.onNodeBlocked?.(node, failedDep);
        continue;
      }
      runnable.push(node);
    }

    await pool(runnable, concurrency, async (node) => {
      let attempt = 0;
      let result;
      while (attempt < maxAttempts) {
        attempt += 1;
        await hooks.onNodeStart?.(node, attempt);
        result = await execute(node, attempt);
        if (result.ok || result.blocked) break;
        if (attempt < maxAttempts) await hooks.onNodeRetry?.(node, attempt, result);
      }
      results.set(node.id, { ...result, attempts: attempt });
      await hooks.onNodeEnd?.(node, results.get(node.id));
    });
  }

  const failed = [...results.values()].filter((r) => !r.ok && !r.blocked);
  const status = failed.length ? "failed" : blocked.size ? "blocked" : "passed";
  return { status, results };
}

async function pool(items, limit, worker) {
  const queue = [...items];
  const size = Math.max(1, Math.min(limit, queue.length || 1));
  const runners = Array.from({ length: size }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item) await worker(item);
    }
  });
  await Promise.all(runners);
}
