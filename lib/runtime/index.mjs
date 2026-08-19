import { runGraph as localRunGraph } from "./local.mjs";

/**
 * Runtimes schedule the Gate 5 DAG. The contract is deliberately narrow so an alternative
 * runtime (LangGraph.js checkpointing, a remote executor) can drop in without touching gates,
 * prompts, or artifacts:
 *
 *   runGraph({ plan, execute, concurrency, maxAttempts, hooks }) -> { status, results }
 *     execute(node)  -> { ok, exitCode?, summary?, logPath?, blocked? }   (caller-supplied)
 *     hooks.onNode*  -> state transitions, awaited so persistence stays ordered
 */
const RUNTIMES = {
  local: { id: "local", label: "in-process wave scheduler", runGraph: localRunGraph },
  langgraph: {
    id: "langgraph",
    label: "LangGraph.js barrier graph",
    // Optional peer dependency, so the adapter module is imported on demand.
    runGraph: async (args) => (await import("./langgraph.mjs")).runGraph(args),
  },
};

export const RUNTIME_IDS = Object.keys(RUNTIMES);

export function getRuntime(id = "local") {
  const runtime = RUNTIMES[id];
  if (!runtime) throw new Error(`unknown runtime "${id}" — choose one of: ${RUNTIME_IDS.join(", ")}`);
  return runtime;
}
