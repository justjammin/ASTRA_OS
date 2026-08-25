---
name: astra-mcp
description: Use the Astra MCP tools for durable five-gate software-factory runs, human approval, and resumable interaction waits.
---

# Astra through MCP

Use one run per project and keep all transitions in the shared `.astra/` ledger.

1. `astra_start` creates a run from a concrete intent.
2. `astra_status` reports the current gate, validation, and pending interaction.
3. `astra_run` drives the current gate; use `dryRun: true` to preview.
4. Present artifacts and validation to the user; `astra_approve` requires `human: true`.
5. `astra_respond` needs the exact `requestId` and `resumeToken` for command/input waits.
6. `astra_session` lists/resumes sessions; `astra_complete` closes one on explicit request.

Never write protocol diagnostics to stdout. The bundled stdio bridge redirects runtime logs to stderr.

