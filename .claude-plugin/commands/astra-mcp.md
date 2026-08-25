---
description: Operate a human-gated Astra run through MCP.
argument-hint: <start|status|run|approve|respond|complete|session>
---

# Astra MCP

Use the `astra_*` MCP tools for `$ARGUMENTS`. Call `astra_status` first when resuming a project.
The ledger phase and artifact validation are authoritative. Ask the user for an explicit decision
before calling `astra_approve` with `human: true`; never infer approval from a conversational “looks
good” unless the user clearly approved the gate.

