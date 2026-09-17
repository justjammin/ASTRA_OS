---
name: stella
description: Use Astra's MCP gates with Claude-native work and subagents for durable, human-approved software-factory runs.
---

# Stella for Claude

Use the Astra MCP server and Claude's native work/subagent facilities. Keep one run per project;
`.astra/<slug>/status.json` is authoritative.

1. Call `astra_start`, or `astra_session` with `action: "list"` to resume an existing run.
2. Call `astra_check` before every transition.
3. Call `astra_gate` to get the rendered prompt/contracts from `lib/prompts/gate*.md`, then dispatch the packet with native Claude work/subagents. At Gate 2, aggregate native reviewer findings into the audit artifact; at Gate 5, dispatch native DAG subagents and persist the execution artifact. Respect every declared write boundary.
4. Call `astra_check` after host writes to validate and surface artifact checks. Ask the user before `astra_approve` with `human: true`, then call `astra_advance`.
5. Use `astra_loop` for requested rework, `astra_visualizer` for review, and `astra_respond` with the exact resume token for waits.
6. Call `astra_complete` only on explicit request.

Never infer a phase or approval from chat. MCP diagnostics stay on stderr.
Never invoke the astra CLI or `astra_run`; Stella is host-native MCP orchestration.

## Worker context windows

Each native subagent owns its context and compaction independently. Read `workerCompaction` from the gate packet or `compaction` from its reviewer/node packet (default ratio `0.5`). At spawn, apply this policy using the host's documented per-subagent controls when exposed. For a token threshold, use the worker's known model capacity multiplied by the ratio; never substitute cumulative run spend or the coordinator's capacity. If the worker uses a different model, resolve its capacity separately.

If the host exposes no per-subagent control, leave native auto-compaction in charge and report `native-default` with that limitation. Never invent spawn arguments, change global host configuration, or claim a prompt instruction enforces a threshold. Record requested policy and actual support in `<run-root>/docs/worker-context.md`, keyed by worker/session ID; this record belongs to the controller, not the worker's source write boundary. Astra's CLI adapter capabilities do not establish support in a native host.

Tell each worker to preserve its task, acceptance criteria, exact write boundary, decisions, changed files, verification evidence, and remaining work in any supported compaction summary. After compaction, reload authoritative contracts and relevant artifacts before continuing. Compaction preserves the existing task and permissions; it does not restart implementation or authorize wider scope.
