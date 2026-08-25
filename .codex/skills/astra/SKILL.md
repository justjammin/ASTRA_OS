---
name: astra
description: Use the Astra MCP tools when a change needs front-loaded product, architecture, contract, graph, and execution gates with durable artifacts and explicit human approval.
---

# Astra OS through MCP

Use one Astra session per project. The server persists every ledger transition below `.astra/`.

1. Call `astra_start` with a concrete intent, or `astra_session` with `action: "list"` to find an existing session.
2. Call `astra_status` before each transition; the current `phase` is authoritative.
3. Call `astra_run` for the current gate. Use `dryRun: true` when composing an invocation preview.
4. Show the validation result and artifacts to the user. Call `astra_approve` only when the user explicitly approves and pass `human: true`.
5. Call `astra_session` with `action: "resume"` after context compaction or hand-off.
6. For a waiting command or input, return the request id and ask the user for a decision; call `astra_respond` with the exact `resumeToken`.
7. Call `astra_complete` only when the user asks to close the run.

The MCP transport is JSON-RPC over stdio. Keep stdout reserved for protocol messages; diagnostics belong
on stderr. A run can be resumed from any host that points at the same project directory.

