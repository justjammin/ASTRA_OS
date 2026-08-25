---
description: Start or continue an Astra five-gate run through the local MCP server.
argument-hint: <intent> | status | run | approve | respond | complete | session
---

# Astra

Use the project-local `astra` MCP server for every operation. Start with `astra_status` when a
session may already exist. Keep the current ledger phase authoritative, surface validation failures,
and ask the user before calling `astra_approve` or an all-gate run with `human: true`.

