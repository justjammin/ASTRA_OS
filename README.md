![/|STR/| OS](assets/astra-os.svg)

**Spec Driven Development focused micro harness; driven end to end by one headless agent CLI.**

| Dark — Horizon graphite / bone / lime | Light — same tokens, inverted |
| --- | --- |
| ![Astra OS review console, dark mode](assets/screens/console-dark.png) | ![Astra OS review console, light mode](assets/screens/console-light.png) |

---

Astra OS is a portable agent harness. It does not run its own model loop; it drives the coding CLI you already use (`claude`, `droid`, `opencode`, `hermes`, or `codex`) through five front-loaded spec driven development  gates, validating the artifacts each gate leaves on disk and stopping for human approval between every one.

The premise, started from a journey into harness orchestration, graph engineering, and Spec Driven Development: codebase rot comes from letting agents skip design. So design is front-loaded, gated, and machine-checked. An announced-but-unrun gate is impossible, because every gate block is rendered from artifacts on disk rather than typed by the agent.

## Install

```bash
npx @ninjamin/astra-os          # copies the astra + grunt skills into ~/.claude/skills and ~/.codex/skills, builds the role map
npm i -g @ninjamin/astra-os     # or install the astra CLI globally (preferred)
```

Also installable as a plugin: `.claude-plugin/`, `.codex-plugin/`, and `plugin.source.json` ship in the package, with `skills/`, `commands/`, and `agents/` wired up.

## Quickstart

```bash
astra doctor                                    # which agent CLIs are on PATH
astra start "add usage-based billing" --agent claude --judge magi
astra run                                       # Gate 1: product intent + UI mockups
astra viz                                       # retro review console at 127.0.0.1:4371
astra approve product && astra advance          # human clears the gate
astra run                                       # Gate 2 …
```

## The five gates

| # | Gate | Role | Artifacts |
|---|---|---|---|
| 1 | Product Intent & Visual Spec | Product Architect | `docs/01-product.md`, `json/ui-layout.json` |
| 2 | Architecture & Adversarial Audit | System Designer + grunt / MAGI | `docs/02-architecture.md`, `json/system-architecture.json`, `json/audit.json` |
| 3 | Program Design & Contract Hardening | Program Designer | `docs/03-program-design.md`, `json/call-stack-types.json` |
| 4 | Graph Engineering & Role Allocation | Graph Engineer | `docs/04-slices.md`, `PLAN.md`, `json/plan.json` |
| 5 | Testing Trophy Execution | Slice workers | `json/dag-execution.json`, `00-status.md` |

Everything lands under `.astra/<slug>/`. The ledger is `status.json`; its human mirror is `00-status.md`.

**Gate 1** bans technical jargon outright — no frameworks, endpoints, schemas, or file paths in prose. It emits `ui-layout.json`, which the visualizer renders as real HTML sandbox mockups so a non-technical stakeholder can validate intent before any architecture exists.

**Gate 2** designs service fit, interfaces, data model, and sequence flows including failure paths, then hands the design to an adversarial reviewer before any human reads it. `--judge solo` runs one skeptic; `--judge magi` runs Melchior, Balthasar, and Casper independently. Personas each write one findings file; the harness merges them arithmetically, so an unresolved `P0` rejects the gate no matter what the personas declared. Findings land in `system-architecture.json` as `riskFlags`, rendered beside the flow they attack.

**Gate 3** writes contracts, not code: exact file paths, full type declarations, function signatures with no bodies, call stacks, error contract, and per-layer test assertions. Every path it names becomes a write boundary at Gate 5 — a path missing here cannot be written later.

**Gate 4** decomposes slices into a DAG. Each node carries its own scoped role: an ≤80-word system prompt, a write boundary drawn only from the Gate 3 contract, and declared inputs and outputs. The tracer slice lands first.

**Gate 5** runs the graph through the Testing Trophy: `static` (lint + type/AST), `unit` (isolated domain calculations), `integration` (DB, API, cross-component with real wiring — the heaviest layer), and `e2e` (one traced path per slice). A slice whose last node is `implement` is rejected at Gate 4 validation. State streams to the visualizer on every transition.

## One agent, the whole pipeline

The agent that wrote the product intent writes the code. Reasoning context stays coherent across gates instead of being handed between vendors.

| Agent CLI | Headless invocation | Notes |
|---|---|---|
| `claude` | `claude -p "$PROMPT" --dangerously-skip-permissions` | Long-horizon reasoning gates |
| `droid` | `droid exec --auto high "$PROMPT"` | High-speed vertical-slice generation |
| `opencode` | `opencode run --quiet "$PROMPT"` | Pragmatic audits, script generation |
| `hermes` | `hermes chat --system "$ROLE" --message "$PROMPT"` | Native system-prompt slot |
| `codex` | `codex exec --file prompt.txt` | Fast static verification, focused unit tests |

Pick with `--agent`. Adapters live in `lib/adapters.mjs`; adding one is a `build()` function.

## Write boundaries are enforced, not requested

Git is the witness. Before and after every Gate 5 node, Astra diffs `git status --porcelain`; a fresh file outside that node's `role.writeBoundary` fails the node. A node that cannot finish inside its boundary prints `BLOCKED: <reason>`, which is a correct outcome. Widening the boundary is not.

## Roles

Thirteen roles ship vendored in `agents/` — five gate roles, four grunt personas, four Testing Trophy workers — so a run never depends on an external marketplace. `astra roles scan` additionally indexes external roots (`~/.claude/agents`, a wshobson-style marketplace, `~/.factory/droids`) into a lean map at `~/.astra/map/`. At Gate 5 a matching specialist is hydrated *on top of* the vendored worker for domain depth. Nothing is installed, and no ambient context is spent until spawn time.

```bash
astra roles scan
astra roles list
astra roles show astra-integration-verifier
```

## grunt

`grunt` is Astra's adversarial reviewer, with its catalogs, judge protocol, and MAGI tribunal intact: pattern selection by observed pressure, rejection with the missing evidence named, a grounding taxonomy where a `claim` needs `file:line` and a `guess` is always low confidence, and the P0/P1/P2 severity ladder. It runs at Gate 2 and can be invoked directly for design or code review.

## Runtime

The DAG scheduler sits behind one interface so it can be swapped without touching gates, prompts, or artifacts:

```js
runGraph({ plan, execute, concurrency, maxAttempts, hooks }) -> { status, results }
```

`--runtime local` (default) is the bundled in-process wave scheduler: dependency-ordered waves, bounded concurrency, one retry per node, and failed nodes blocking only their dependents.

`--runtime langgraph` compiles the same plan into a LangGraph.js graph, so you get its streaming, checkpointing, and LangSmith tracing. Each wave is fanned out from a barrier node instead of wiring dependencies as direct edges — LangGraph fires a node as soon as any incoming edge fires, so dependencies landing in different supersteps would otherwise run a node twice. Blocking, retries, and the concurrency cap match the local runtime exactly (`test/runtime-langgraph.test.mjs` asserts parity).

```bash
npm install @langchain/langgraph          # optional peer dependency
astra start "…" --runtime langgraph       # astra doctor shows which runtimes are ready
```

## Visualizer

`astra viz` serves a 1980s-retro review console (Chakra Petch, CRT scanlines, neon) that reads the run root and streams updates over SSE: Gate 1 mockups, Gate 2 sequence diagrams next to audit risk flags, Gate 3 call graph and type boundaries, Gate 4 DAG in topological waves, Gate 5 live node state. Approve or request changes per gate from the footer. Open questions render read-only — answer them in your agent session.

Every Markdown file in the run root is rendered as HTML (headings, tables, code, lists) and each one pops out into a full-width modal, so a 36 KB program design is readable without leaving the console. A `TRANSCRIPT` panel tails the last 50 lines of whichever agent-CLI log is currently being written — that output never reaches your TUI, since the harness drives the CLI headlessly.

![Document viewers popping out into full-width modals](assets/screens/doc-viewers.gif)

## Commands and exit codes

```
astra                                install skills, plugin files, and the role map
astra start "<intent>"               [--agent …] [--judge solo|magi] [--runtime local|langgraph] [--out <dir>]
astra run [--all] [--dry-run]        drive the current gate
astra gate [<gate>]                  validate a gate from disk
astra approve <gate>                 human-only
astra advance                        next gate
astra loop --to=<gate> --reason="…"  rework (budget 2 per gate)
astra status [--json] | astra viz | astra roles | astra doctor | astra complete
```

| Code | Meaning |
|---|---|
| 0 | Gate satisfied or transition performed |
| 1 | Artifacts missing or invalid — the output names each failure |
| 2 | Loop budget exhausted — escalate to the human |
| 3 | Transition refused: wrong phase, gate open, no active run |
| 4 | Human-only action attempted by an agent |

## Development

```bash
npm test          # node --test, zero dependencies
node visualizer/server.mjs .astra/<slug>
```

Zero required runtime dependencies (LangGraph.js is an optional peer), Node >= 18, ESM throughout. Schemas in `lib/schemas/` are the artifact contract; the validator in `lib/validate.mjs` implements the subset they use.

## License

Apache-2.0 — see [LICENSE](LICENSE). Wordmark glyphs are Chakra Petch Bold, converted to outlines, under the SIL Open Font License 1.1.
