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
