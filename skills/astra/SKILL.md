---
name: astra
description: >
  Astra OS — front-loaded software factory harness. Drives one headless coding CLI (claude, droid,
  opencode, hermes, or codex) through five gated phases: product intent with visual mockups,
  architecture with an adversarial audit (grunt solo or the MAGI tribunal), program design
  contracts with exact signatures, DAG planning with scoped per-node agent roles, and Testing
  Trophy execution streamed to a retro visualizer. Human approval between every gate. Triggers on:
  "/astra", "astra this", "run the astra pipeline", "build this through the gates", "spec then build
  end to end". Use when a change deserves design before code and proof before sign-off.
---

# astra — the five-gate factory

One agent CLI carries the whole run. The agent that wrote the product intent writes the code, so
its reasoning context stays coherent across gates. Every gate leaves artifacts on disk; the
harness validates those artifacts and refuses to advance on an agent's assurance.

```
Gate 1  Product Intent & Visual Spec        docs/01-product.md        json/ui-layout.json
Gate 2  Architecture & Adversarial Audit    docs/02-architecture.md   json/system-architecture.json  json/audit.json
Gate 3  Program Design & Contracts          docs/03-program-design.md json/call-stack-types.json
Gate 4  Graph Engineering & Role Allocation docs/04-slices.md PLAN.md json/plan.json
Gate 5  Testing Trophy Execution            json/dag-execution.json   00-status.md
```

Artifacts live under `.astra/<slug>/`. The ledger is `.astra/<slug>/status.json`; the human-readable
mirror is `00-status.md`.

## Commands

```
astra start "<intent>" [--agent claude|droid|opencode|hermes|codex] [--judge solo|magi] [--runtime local|langgraph]
astra run [--all] [--dry-run]        # drive the current gate
astra gate [<gate>]                  # validate a gate from disk
astra approve <gate>                 # human-only
astra advance                        # next phase
astra loop --to=<gate> --reason="…"  # go back (budget 2 per gate)
astra viz [--port 4319]              # retro review console
astra roles scan|list|show <name>    # role map
astra doctor                         # which agent CLIs are installed
```

Exit codes are the contract:

| Code | Meaning |
|---|---|
| 0 | Gate satisfied or transition performed |
| 1 | Artifacts missing or invalid — the output names each failure |
| 2 | Loop budget exhausted — escalate to the human |
| 3 | Transition refused: wrong phase, gate open, no active run |
| 4 | Human-only action attempted by an agent |

## Rules you cannot talk around

- **Never write a gate block by hand.** `astra gate <id>` renders it from artifacts on disk. A gate
  that never ran exits 1, so an announced-but-unrun gate is impossible.
- **`astra approve` belongs to the human.** It refuses without a TTY (exit 4). Surface the command;
  do not run it for them.
- **`astra advance` is the only way forward** and refuses while the current gate is unclear.
- **Gate 5 write boundaries are enforced.** Each node may only touch paths listed in its
  `role.writeBoundary`, drawn from `json/call-stack-types.json`. The harness diffs git before and
  after each node; a fresh file outside the boundary fails that node.
- **A node that cannot finish inside its boundary prints `BLOCKED: <line>`.** That is a correct
  outcome. Widening the boundary yourself is not.

## Running a gate

1. `astra status` to see the phase. Do not guess.
2. `astra run` — the harness renders the gate prompt, prepends the vendored role persona, and
   invokes the run's agent CLI headlessly. If validation fails, it takes exactly one repair turn
   quoting the schema errors, then reports.
3. `astra viz` and review. Gate 1 renders UI mockups, Gate 2 draws sequence flows next to audit
   risk flags, Gate 3 shows the call graph and type boundaries, Gate 4 shows the DAG in waves,
   Gate 5 streams node state live.
4. Human runs `astra approve <gate>` then `astra advance`. Findings that need rework:
   `astra loop --to=<gate> --reason="<one line>"`.

## Gate 2 and the judge

`--judge solo` runs one skeptic; `--judge magi` runs Melchior, Balthasar, and Casper independently.
Personas write one findings file each; the harness merges them arithmetically — an unresolved `P0`
rejects the gate no matter what the personas declare. See the `grunt` skill for the catalogs, judge
protocol, and severity ladder. Recommend `magi` for P0 risk, irreversible changes, or low
confidence, and let the human choose it.

## Roles

Astra ships 13 vendored roles in `agents/` (five gate roles, four grunt personas, four Testing
Trophy workers), so a run never depends on an external marketplace. `astra roles scan` also indexes
external roots (`~/.claude/agents`, a wshobson-style marketplace, `~/.factory/droids`) into
`~/.astra/map`. At Gate 5, a matching external specialist is hydrated *on top of* the vendored
worker for domain depth; nothing is installed and no ambient context is spent until spawn time.

## Runtime

The DAG scheduler sits behind one interface (`runGraph({ plan, execute, concurrency, hooks })`).
`--runtime local` is the bundled in-process wave scheduler: dependency-ordered waves, bounded
concurrency, one retry per node, and failed nodes blocking only their dependents. `--runtime
langgraph` is reserved for the optional LangGraph.js adapter and exits 4 until it is installed.

## When not to use Astra

Single-file fixes, typo corrections, and mechanical refactors do not need five gates. Use Astra when
the change has design risk, crosses components, or must survive review.
