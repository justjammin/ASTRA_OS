# Astra MCP bridge

`lib/mcp-server.mjs` exposes the existing Astra ledger and pipeline through a small MCP stdio
server. It has no MCP package dependency: newline-delimited JSON-RPC is parsed with Node's standard
library, and the operation handlers reuse `lib/ledger.mjs`, `lib/gates.mjs`, `lib/pipeline.mjs`, and
`lib/policy.mjs`.

## Operations

| Operation | Purpose | Guard |
| --- | --- | --- |
| `astra_start` | Create `.astra/<slug>/status.json` | Refuses while another run is active |
| `astra_status` | Read ledger, current gate validation, and pending interaction | Read-only |
| `astra_run` | Execute the current gate and persist `ran`/`failed` | `all` requires `human: true` |
| `astra_approve` | Clear a validated gate | Requires `human: true` |
| `astra_respond` | Approve/deny/answer a pending wait | Requires `resumeToken` |
| `astra_complete` | Close a run | Does not rewrite artifacts |
| `astra_session` | List, open, resume, or close sessions; includes broker budget/workers when present | Delegates to the operations above |

The server also accepts direct JSON-RPC names (`astra/start`, `astra/status`, and so on) and MCP's
standard `initialize`, `ping`, `tools/list`, and `tools/call` methods. Notifications receive no
response. Invalid JSON, malformed requests, unknown methods, oversized lines, and operation failures
use JSON-RPC errors or MCP `isError` tool results without exposing stack traces.

## Host wiring

Run it from the project root:

```json
{
  "command": "astra-mcp",
  "args": []
}
```

`astra-mcp` is the package entry point for installed hosts. During repository development, the
equivalent command is `node lib/mcp-server.mjs`.

The committed harness examples are scoped by host:

- Claude: `.claude-plugin/.mcp.json`, `.claude-plugin/commands/astra-mcp.md`, and `.claude-plugin/skills/astra-mcp/SKILL.md`.
- Codex: `.codex/config.toml`, `.codex/commands/astra.md`, and `.codex/skills/astra/SKILL.md`.
- Factory: `.factory-plugin/plugin.json`, `.factory-plugin/mcp.json`, `.factory-plugin/commands/astra.md`, and `.factory-plugin/skills/astra/SKILL.md`.

Keep the server's stdout connected to the host. Runtime diagnostics are redirected to stderr so they
cannot corrupt JSON-RPC framing. Restart the host after changing a config file.
