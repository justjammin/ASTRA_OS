---
name: open-pencil
description: Work with Astra's generated OpenPencil UI-story artifacts for graphical user-interface components. Use when a User Story includes screens or UI controls and Astra has produced designs/user-story.fig and assets/user-story.png for read-only inspection or download.
---

# OpenPencil UI stories

Use OpenPencil only for the visual half of a UI User Story. The Mermaid skill still describes the interaction flow; this skill covers inspection of the editable `.fig` file and its PNG preview after Astra materializes them.

## Astra workflow

1. Determine that the story actually contains a graphical component. Use Mermaid alone for CLI, API, backend, automation, and other non-UI work.
2. Read the User Story and its declared screens/states; keep visible copy and controls consistent with the Mermaid flow.
3. Let Astra materialize the UI story. Agents must not invent files outside the declared Gate 1 write scope and must not hand-edit generated artifacts.
4. Treat `designs/user-story.fig` as the editable source and `assets/user-story.png` as the review thumbnail. Both are read-only during the gate; the review console exposes them through its User Story pop-out.
5. If inspection is needed and the package is installed, use the project-local pinned CLI:

```sh
npm exec --no -- openpencil info designs/user-story.fig
npm exec --no -- openpencil tree designs/user-story.fig --depth 3
```

The Astra package pins `@open-pencil/cli@0.14.0`. Do not install a global version, use `bunx`, or fetch a different version during a run.

## Import and export boundaries

OpenPencil supports HTML/CSS import and `.fig`/PNG export. Astra owns that conversion with fixed, argument-array CLI calls so story text is escaped and output paths remain inside the run root. Do not bypass the harness with shell interpolation or arbitrary output paths.

When reviewing a generated design, inspect structure and export only to a temporary path or the declared artifact path. Never overwrite source code, status files, or another run's artifacts.

## Security and agent boundary

- Do not register `open-pencil` as an MCP server and do not use the upstream MCP workflow in unattended Astra runs.
- Do not start or control the desktop OpenPencil app from a gate worker.
- Do not use remote URLs, external images, or untrusted CSS in generated story content.
- If the `.fig` or PNG artifact is absent, report the materialization error; do not silently substitute an unreviewed mockup.
