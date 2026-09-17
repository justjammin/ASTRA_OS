---
name: stella
description: Use Astra's host-native MCP workflow when a change needs durable product, architecture, contract, graph, and execution gates.
---

# Stella — host-native Astra workflow

Stella drives the five Astra gates through MCP while the host owns work, context, and subagents.
Use one session per project; `.astra/<slug>/status.json` is authoritative.

1. Call `astra_start` for a new intent, or `astra_session` with `action: "list"` to find a run.
2. Call `astra_check` before every operation and use its current phase.
3. Call `astra_gate` to get the rendered prompt/contracts, then run that packet with the host's native work/subagent facilities; keep workers inside their declared write boundaries. At Gate 2, dispatch native reviewers and aggregate their findings into the audit artifact; at Gate 5, dispatch native DAG subagents and persist the execution artifact.
4. Call `astra_check` after host writes to validate the artifacts, then show its checks and artifact paths to the user.
5. After explicit approval, call `astra_approve` with `human: true`, then `astra_advance`. Use `astra_loop` for requested rework.
6. Use `astra_visualizer` when the user wants the review console. Resolve waits with `astra_respond` and the exact resume token.
7. Call `astra_complete` only when the user asks to close the run.

Gate packets are derived from the checked-in prompt files; do not invent gate contracts. Human approval remains required between gates. Keep MCP diagnostics off the protocol stream.

Never invoke the astra CLI or `astra_run`; Stella is host-native MCP orchestration.

## Worker context windows

Each native subagent owns its context and compaction independently. Read `workerCompaction` from the gate packet or `compaction` from its reviewer/node packet (default ratio `0.5`). At spawn, apply this policy using the host's documented per-subagent controls when exposed. For a token threshold, use the worker's known model capacity multiplied by the ratio; never substitute cumulative run spend or the coordinator's capacity. If the worker uses a different model, resolve its capacity separately.

If the host exposes no per-subagent control, leave native auto-compaction in charge and report `native-default` with that limitation. Never invent spawn arguments, change global host configuration, or claim a prompt instruction enforces a threshold. Record requested policy and actual support in `<run-root>/docs/worker-context.md`, keyed by worker/session ID; this record belongs to the controller, not the worker's source write boundary. Astra's CLI adapter capabilities do not establish support in a native host.

Tell each worker to preserve its task, acceptance criteria, exact write boundary, decisions, changed files, verification evidence, and remaining work in any supported compaction summary. After compaction, reload authoritative contracts and relevant artifacts before continuing. Compaction preserves the existing task and permissions; it does not restart implementation or authorize wider scope.
