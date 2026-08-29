---
description: Run the Astra OS five-gate factory on an intent, driven end to end by one headless agent CLI.
argument-hint: <intent> [--agent claude|droid|opencode|hermes|codex] [--judge solo|magi]
---

Drive the local `astra` CLI for: $ARGUMENTS

Follow this sequence:

1. Confirm the intent is specific enough. If it is not, ask one focused batch of 2-3 questions before Gate 1. Do not expand vagueness into invented requirements.
2. Run `astra start "<intent>"` with the chosen agent and judge mode. Do not compose the readiness block by hand; the command prints it from the ledger.
3. Drive one gate at a time with `astra run`. After each gate, render the gate block with `astra gate <id>` and offer `astra viz` for visual review.
4. `astra approve <gate>` is the human's command. Surface it; never run it yourself.
5. `astra advance` moves forward and refuses while a gate is unclear. Rework goes through `astra loop --to=<gate> --reason="<one line>"`, budget 2 per gate.
6. Answer any open questions the artifacts raise in this session. The visualizer renders them read-only.
