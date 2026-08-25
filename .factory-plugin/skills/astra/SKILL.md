---
name: astra
description: Use Astra for changes that need durable product, architecture, contract, graph, and execution gates across coding-agent hosts.
---

# Astra MCP workflow

The Astra MCP server is a thin control plane over the shared `.astra/<slug>/status.json` ledger.

- Start with `astra_start` for a new intent, or `astra_session` with `action: "list"` to discover runs.
- Read `astra_status` before every transition; do not infer phase from conversation state.
- Run one current gate with `astra_run`. Keep `dryRun: true` for previews.
- Review the returned `validation` and artifact paths with the user before `astra_approve` using `human: true`.
- Resolve waits with `astra_respond` and the exact `resumeToken`; never guess a token.
- Use `astra_session` with `action: "resume"` after a handoff, and `astra_complete` only on request.

The stdio stream is newline-delimited JSON-RPC. Diagnostics stay on stderr so host framing remains valid.

