# Astra MCP bridge

`lib/mcp-server.mjs` exposes Astra's ledger, gate validation, transitions, and visualizer lifecycle
through a small MCP stdio server. It has no MCP package dependency: newline-delimited JSON-RPC is
parsed with Node's standard library. Stella builds each gate packet from `lib/prompts/gate*.md` and
lets the host's native work/subagent tools execute it.

## Operations

| Operation | Purpose | Guard |
| --- | --- | --- |
| `astra_start` | Create `.astra/<slug>/status.json` | Refuses while another run is active |
| `astra_check` | Read ledger, current gate validation, and pending interaction | Read-only |
| `astra_status` | Compatibility alias for `astra_check` | Read-only |
| `astra_gate` | Prepare the rendered gate prompt/contracts and validate its artifacts | Read-only |
| `astra_run` | Legacy CLI-backed gate execution | Preserved for compatibility; Stella never calls it |
| `astra_approve` | Clear a validated gate | Requires `human: true` |
| `astra_advance` | Move to the next cleared gate | Current gate must be approved |
| `astra_loop` | Return to an earlier gate for rework | Per-gate loop budget |
| `astra_visualizer` | Start, inspect, or stop the review console | Read-only lifecycle |
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

- Claude: `.claude-plugin/.mcp.json`, `.claude-plugin/commands/astra-mcp.md`, and `.claude-plugin/skills/stella/SKILL.md`.
- Codex: `.codex/config.toml`, `.codex/commands/astra.md`, and `.codex/skills/stella/SKILL.md`.
- Factory: `.factory-plugin/plugin.json`, `.factory-plugin/mcp.json`, `.factory-plugin/commands/astra.md`, and `.factory-plugin/skills/stella/SKILL.md`.

## Automatic installation

`npm install` runs the package postinstall. It detects `claude`, `codex`, and `droid`, then copies
`stella`, `grunt`, `mermaid`, and `open-pencil` plus the generic Astra commands into only those hosts. Claude and Codex are
registered through their official MCP CLI interfaces when present. Factory merges the `astra`
stdio server into `~/.factory/mcp.json` with an atomic replacement. Existing `astra` entries are
never overwritten; a warning explains the conflict. The server always launches with the current
Node executable and the package's absolute `lib/mcp-server.mjs` path.

Run `astra install` to repeat the operation after changing hosts. The installer removes only exact
hash matches of the shipped legacy Astra skill copies; edited or unrelated directories remain.

Keep the server's stdout connected to the host. Runtime diagnostics are redirected to stderr so they
cannot corrupt JSON-RPC framing. Restart the host after changing a config file.
