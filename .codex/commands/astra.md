---
description: Drive the Astra five-gate software factory through its local MCP server.
argument-hint: <intent> | status | run | approve | respond | complete
---

# Astra MCP

Use the `astra` MCP server configured in `.codex/config.toml` for project-local runs.

Operation map:

- `astra_start` opens a run from an intent.
- `astra_status` reads the active ledger and validates the current gate.
- `astra_run` runs one gate and persists its result; pass `dryRun: true` to preview.
- `astra_approve` clears a gate only after reviewing its artifacts; it requires `human: true`.
- `astra_respond` resolves a pending command/input interaction with its `resumeToken`.
- `astra_complete` closes a run without rewriting artifacts.
- `astra_session` lists or resumes project sessions.

Read status before acting. Never infer a gate from chat history, and never pass `human: true`
unless the user explicitly made the approval decision.

