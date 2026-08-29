---
name: stella
description: Use Astra's MCP gates with Factory-native work and subagents for durable, human-approved software-factory runs.
---

# Stella for Factory

Use the Astra MCP server and Factory's native work/subagent facilities. Keep one run per project;
`.astra/<slug>/status.json` is authoritative.

1. Call `astra_start`, or `astra_session` with `action: "list"` to resume an existing run.
2. Call `astra_check` before every transition.
3. Call `astra_gate` to get the rendered prompt/contracts from `lib/prompts/gate*.md`, then run the packet with native Factory work/subagents. At Gate 2, aggregate native reviewer findings into the audit artifact; at Gate 5, dispatch native DAG subagents and persist the execution artifact. Respect every declared write boundary.
4. Call `astra_check` after host writes to validate and surface artifact checks. Ask the user before `astra_approve` with `human: true`, then call `astra_advance`.
5. Use `astra_loop` for requested rework, `astra_visualizer` for review, and `astra_respond` with the exact resume token for waits.
6. Call `astra_complete` only on explicit request.

Never infer a phase or approval from chat. MCP diagnostics stay on stderr.
Never invoke the astra CLI or `astra_run`; Stella is host-native MCP orchestration.
