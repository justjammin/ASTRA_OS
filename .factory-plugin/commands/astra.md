---
description: Start or continue an Astra five-gate run through the local MCP server.
argument-hint: <intent> | status | run | approve | respond | complete | session
---

# Astra

Use the project-local `astra` MCP server for every operation. Call `astra_check` first when a
session may already exist, keep the current ledger phase authoritative, surface validation failures,
and ask the user before calling `astra_approve` or an all-gate run with `human: true`.
