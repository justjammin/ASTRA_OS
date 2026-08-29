import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startVisualizer } from "../visualizer/server.mjs";

const fixtureUiLayout = {
  meta: { slug: "fixture-run", intent: "Review fixture UI" },
  wireDsl: 'project "Fixture" { screen u1 { layout card(padding: lg) { component Heading text: "Fixture UI" component Button text: "Continue" variant: primary } } }',
  screens: [{ id: "u1", name: "Fixture", purpose: "review the fixture", elements: [{ type: "heading", label: "Fixture UI" }] }],
};

const fixturePlan = {
  meta: { slug: "fixture-run", intent: "Review fixture plan", agent: "droid" },
  slices: [{
    id: "s1",
    title: "Tracer slice",
    demo: "A visible tracer works",
    tracer: true,
    criteria: ["Tracer renders"],
    nodes: ["n1"],
  }],
  nodes: [{
    id: "n1",
    title: "Render tracer",
    slice: "s1",
    kind: "implement",
    deps: [],
    role: {
      name: "Builder",
      systemPrompt: "Build tracer",
      writeBoundary: ["src/tracer.mjs"],
    },
  }],
};

const fixtureExecution = {
  meta: { slug: "fixture-run", agent: "droid" },
  status: "idle",
  nodes: [{
    id: "n1",
    title: "Render tracer",
    kind: "implement",
    slice: "s1",
    status: "pending",
  }],
};

const fixtureUserStory = {
  meta: { slug: "fixture-run", intent: "Review fixture story", surface: "ui" },
  mermaid: "flowchart TD\n  start[User opens the product] --> result[User sees the result]",
  screens: [{
    id: "u1",
    name: "Result",
    purpose: "Review the result",
    elements: [{ type: "heading", label: "Result" }],
    acceptance: ["The user can review the result."],
  }],
};

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "astra-visualizer-"));
  await mkdir(join(root, "json"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "status.json"), JSON.stringify({
    meta: {
      slug: "fixture-run",
      intent: "Review fixture",
      agent: "droid",
      judge: "grunt",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
    phase: "product",
    gates: {
      product: { status: "ran", ranAt: null, clearedAt: null, loops: 0 },
      architecture: { status: "pending", ranAt: null, clearedAt: null, loops: 0 },
      design: { status: "pending", ranAt: null, clearedAt: null, loops: 0 },
      plan: { status: "pending", ranAt: null, clearedAt: null, loops: 0 },
      execute: { status: "pending", ranAt: null, clearedAt: null, loops: 0 },
    },
    history: [],
  }) + "\n");
  await writeFile(join(root, "json/ui-layout.json"), JSON.stringify(fixtureUiLayout));
  await writeFile(join(root, "json/plan.json"), JSON.stringify(fixturePlan));
  await writeFile(join(root, "json/dag-execution.json"), JSON.stringify(fixtureExecution));
  return root;
}

async function withServer(callback, root = null) {
  const runRoot = root ?? await fixtureRoot();
  const visualizer = await startVisualizer({ runRoot, port: 0 });
  try {
    return await callback(visualizer, runRoot);
  } finally {
    await visualizer.close();
    if (!root) await rm(runRoot, { recursive: true, force: true });
  }
}

test("serves HTML shell on an ephemeral port", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    assert.match(await response.text(), /Astra OS/);
  });
});

test("state returns nulls for missing artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "astra-visualizer-empty-"));
  try {
    await withServer(async ({ url }) => {
      const response = await fetch(`${url}/api/state`);
      const state = await response.json();
      assert.equal(response.status, 200);
      assert.equal(state.ok, true);
      assert.equal(state.ledger, null);
      assert.equal(state.artifacts.uiLayout, null);
      assert.equal(state.artifacts.systemArchitecture, null);
      assert.equal(state.docs.product, null);
      assert.deepEqual(state.gates.map((gate) => gate.status), ["pending", "pending", "pending", "pending", "pending"]);
    }, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses fixture artifacts and exposes file mtimes", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/api/state`);
    const state = await response.json();
    assert.equal(state.ok, true);
    assert.equal(state.slug, "fixture-run");
    assert.deepEqual(state.artifacts.uiLayout, fixtureUiLayout);
    assert.equal(state.wireframes.ok, true);
    assert.equal(state.wireframes.project.screens[0].name, "u1");
    assert.deepEqual(state.artifacts.plan, fixturePlan);
    assert.deepEqual(state.artifacts.execution, fixtureExecution);
    assert.equal(typeof state.mtimeMs["status.json"], "number");
    assert.equal(typeof state.mtimeMs["json/plan.json"], "number");
  });
});

test("malformed JSON becomes null", async () => {
  const root = await fixtureRoot();
  try {
    await writeFile(join(root, "json/audit.json"), "{not-json");
    await withServer(async ({ url }) => {
      const response = await fetch(`${url}/api/state`);
      const state = await response.json();
      assert.equal(response.status, 200);
      assert.equal(state.artifacts.audit, null);
    }, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serves User Story metadata and only whitelisted preview/design artifacts", async () => {
  const root = await fixtureRoot();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  try {
    await writeFile(join(root, "json/user-story.json"), JSON.stringify(fixtureUserStory));
    await mkdir(join(root, "assets"), { recursive: true });
    await mkdir(join(root, "designs"), { recursive: true });
    await writeFile(join(root, "assets/user-story.png"), png);
    await writeFile(join(root, "designs/user-story.fig"), "FIG");

    await withServer(async ({ url }) => {
      const state = await (await fetch(`${url}/api/state`)).json();
      assert.deepEqual(state.artifacts.userStory, fixtureUserStory);
      assert.equal(state.artifacts.userStoryPreview.path, "assets/user-story.png");
      assert.equal(state.artifacts.userStoryPreview.type, "image/png");
      assert.match(state.artifacts.userStoryPreview.url, /user-story\/preview$/);
      assert.equal(state.artifacts.userStoryDesign.path, "designs/user-story.fig");

      const preview = await fetch(`${url}/api/artifacts/user-story/preview`);
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get("content-type"), "image/png");
      assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
      assert.match(preview.headers.get("content-disposition"), /^inline;/);
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);

      const download = await fetch(`${url}/api/artifacts/user-story/preview?download=1`);
      assert.equal(download.status, 200);
      assert.match(download.headers.get("content-disposition"), /^attachment;/);

      const design = await fetch(`${url}/api/artifacts/user-story/design`);
      assert.equal(design.status, 200);
      assert.equal(design.headers.get("content-type"), "application/octet-stream");
      assert.match(design.headers.get("content-disposition"), /^attachment;.*user-story\.fig/);
      assert.equal(await design.text(), "FIG");

      const traversal = await fetch(`${url}/api/artifacts/user-story/preview/%2e%2e/%2e%2e/package.json`);
      assert.notEqual(traversal.status, 200);
      assert.equal((await traversal.json()).ok, false);
    }, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing User Story binaries return an empty state and 404", async () => {
  const root = await fixtureRoot();
  try {
    await writeFile(join(root, "json/user-story.json"), JSON.stringify({
      meta: { slug: "fixture-run", intent: "Run a report", surface: "non-ui" },
      mermaid: "flowchart TD\n  start[User runs the report] --> done[Report is written]",
    }));
    await withServer(async ({ url }) => {
      const state = await (await fetch(`${url}/api/state`)).json();
      assert.equal(state.artifacts.userStoryPreview, null);
      assert.equal(state.artifacts.userStoryDesign, null);
      const response = await fetch(`${url}/api/artifacts/user-story/preview`);
      assert.equal(response.status, 404);
      assert.equal((await response.json()).ok, false);
    }, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("never serves User Story binaries for non-UI stories or symlink escapes", async () => {
  const root = await fixtureRoot();
  const outside = await mkdtemp(join(tmpdir(), "astra-visualizer-outside-"));
  const png = Buffer.from("outside");
  try {
    await writeFile(join(root, "json/user-story.json"), JSON.stringify({
      meta: { slug: "fixture-run", intent: "Run a report", surface: "non-ui" },
      mermaid: fixtureUserStory.mermaid,
    }));
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(outside, "user-story.png"), png);
    await symlink(join(outside, "user-story.png"), join(root, "assets/user-story.png"));
    await withServer(async ({ url }) => {
      const state = await (await fetch(`${url}/api/state`)).json();
      assert.equal(state.artifacts.userStoryPreview, null);
      const response = await fetch(`${url}/api/artifacts/user-story/preview`);
      assert.equal(response.status, 404);
      assert.deepEqual(await readFile(join(outside, "user-story.png")), png);
    }, root);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("feedback writes approved verdict and rejects bad verdict", async () => {
  await withServer(async ({ url }, root) => {
    const accepted = await fetch(`${url}/api/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gate: "product", verdict: "approved", notes: "Looks clear." }),
    });
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.json();
    assert.equal(acceptedBody.ok, true);
    const saved = JSON.parse(await readFile(join(root, "json/feedback-product.json"), "utf8"));
    assert.equal(saved.gate, "product");
    assert.equal(saved.verdict, "approved");
    assert.equal(typeof saved.receivedAt, "string");

    const rejected = await fetch(`${url}/api/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gate: "product", verdict: "maybe" }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).ok, false);
  });
});

test("feedback requires JSON same-origin requests and refuses symlink targets", async () => {
  const root = await fixtureRoot();
  const outside = await mkdtemp(join(tmpdir(), "astra-visualizer-feedback-outside-"));
  try {
    await writeFile(join(outside, "feedback.json"), "keep");
    await symlink(join(outside, "feedback.json"), join(root, "json/feedback-product.json"));
    await withServer(async ({ url }) => {
      const body = JSON.stringify({ gate: "product", verdict: "approved" });
      const wrongType = await fetch(`${url}/api/feedback`, { method: "POST", body });
      assert.equal(wrongType.status, 415);
      const wrongOrigin = await fetch(`${url}/api/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body,
      });
      assert.equal(wrongOrigin.status, 403);
      const symlinkTarget = await fetch(`${url}/api/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(symlinkTarget.status, 400);
      assert.equal(await readFile(join(outside, "feedback.json"), "utf8"), "keep");
    }, root);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("state exposes every markdown file in the run, not just gate documents", async () => {
  const root = await fixtureRoot();
  try {
    await writeFile(join(root, "00-status.md"), "# Status\n\n| Gate | State |\n|---|---|\n| 1 | ran |\n");
    await writeFile(join(root, "PLAN.md"), "## Nodes\n\n- n1\n");
    await writeFile(join(root, "docs/01-product.md"), "# Widget\n\nPlain language.\n");
    await mkdir(join(root, "docs/extra"), { recursive: true });
    await writeFile(join(root, "docs/extra/notes.md"), "note body\n");
    await writeFile(join(root, "docs/ignored.txt"), "not markdown\n");

    await withServer(async ({ url }) => {
      const state = await (await fetch(`${url}/api/state`)).json();
      assert.deepEqual(state.markdown.map((doc) => doc.path), [
        "00-status.md",
        "PLAN.md",
        "docs/01-product.md",
        "docs/extra/notes.md",
      ]);
      assert.match(state.markdown.at(-1).markdown, /note body/);
      assert.equal(typeof state.markdown[0].bytes, "number");
    }, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serves the markdown renderer module", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/markdown.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
    assert.match(await response.text(), /export function markdownToHtml/);
  });
});

test("serves Mermaid locally with relative chunks and rejects traversal", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/vendor/mermaid/mermaid.esm.min.mjs`);
    if (response.status === 404) {
      // Dependencies are optional in a source checkout; the production package installs Mermaid.
      assert.match((await response.json()).error.message, /Mermaid module is not installed|asset not found/);
    } else {
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /javascript/);
      const source = await response.text();
      const imported = source.match(/(?:from|import)\s*["'](\.\/[^"']+)["']/);
      if (imported) {
        const chunk = await fetch(`${url}/vendor/mermaid/${imported[1].slice(2)}`);
        assert.equal(chunk.status, 200);
      }
    }
    const traversal = await fetch(`${url}/vendor/mermaid/%2e%2e/package.json`);
    assert.notEqual(traversal.status, 200);
    assert.equal((await traversal.json()).ok, false);
  });
});

test("log feed tails the newest transcript, capped at 50 lines", async () => {
  const root = await fixtureRoot();
  try {
    await mkdir(join(root, "logs"), { recursive: true });
    await writeFile(join(root, "logs/gate-1-product.log"), "old gate\n");
    const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`);
    await writeFile(join(root, "logs/gate-2-architecture.log"), `${lines.join("\n")}\n`);
    const now = Date.now() / 1000;
    await utimes(join(root, "logs/gate-1-product.log"), now - 2, now - 2);
    await utimes(join(root, "logs/gate-2-architecture.log"), now, now);

    await withServer(async ({ url }) => {
      const state = await (await fetch(`${url}/api/state`)).json();
      assert.equal(state.logFeed.path, "logs/gate-2-architecture.log");
      assert.equal(state.logFeed.lines.length, 50);
      assert.equal(state.logFeed.lines.at(0), "line 71");
      assert.equal(state.logFeed.lines.at(-1), "line 120");
      assert.equal(state.logFeed.truncated, false);
      assert.deepEqual(state.logFeed.files.map((f) => f.path).sort(), [
        "logs/gate-1-product.log",
        "logs/gate-2-architecture.log",
      ].sort());
    }, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("log feed is null when a run has no transcripts", async () => {
  await withServer(async ({ url }) => {
    const state = await (await fetch(`${url}/api/state`)).json();
    assert.equal(state.logFeed, null);
  });
});

test("refuses static path traversal", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/assets/%2e%2e/%2e%2e/package.json`);
    assert.notEqual(response.status, 200);
    assert.equal((await response.json()).ok, false);
  });
});
