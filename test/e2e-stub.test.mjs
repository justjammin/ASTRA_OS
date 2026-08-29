import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "astra.mjs");

// A stand-in for a real agent CLI: it reads the artifact paths out of the prompt it was handed and
// writes schema-valid content for each one. That exercises prompt rendering, adapter invocation,
// the tribunal merge, and gate validation without spending tokens.
const STUB = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, basename } from "node:path";

const prompt = process.argv.slice(1).join(" ");
const slug = process.env.ASTRA_TEST_SLUG;
const paths = [...new Set(prompt.match(/[\\w./-]*\\.astra\\/[\\w-]+\\/[\\w./-]+/g) ?? [])];
const judgeRun = paths.some((path) => basename(path).startsWith("audit-"));

const content = {
  "01-product.md": "# Widget\\n\\n" + "Plain language product detail. ".repeat(40),
  "02-architecture.md": "## Service fit\\n\\n" + "Design detail with reasoning. ".repeat(40),
  "03-program-design.md": "## File map\\n\\n" + "Contract detail with signatures. ".repeat(40),
  "04-slices.md": "## Slices\\n\\n" + "Slice detail with demos. ".repeat(30),
  "PLAN.md": "## Nodes\\n\\n" + "Node table and wave order. ".repeat(20),
  "user-story.json": JSON.stringify({
    meta: { slug, intent: "stub intent", surface: "non-ui" },
    mermaid: "flowchart TD\\n  start[Run widget command] --> done[Widget is created]",
  }),
  "system-architecture.json": JSON.stringify({
    meta: { slug, intent: "stub intent" },
    services: [{ id: "api", name: "API", kind: "service", responsibility: "serve widgets" }],
    dataModels: [{ name: "Widget", fields: [{ name: "id", type: "string" }] }],
    sequences: [{ id: "q1", name: "create", steps: [{ from: "ui", to: "api", message: "POST /widgets" }] }],
  }),
  "call-stack-types.json": JSON.stringify({
    meta: { slug, language: "typescript" },
    files: [{ path: "src/widget.ts", purpose: "widget domain", exports: [{ kind: "function", name: "create", signature: "create(input: Input): Widget" }] }],
    callStacks: [{ id: "c1", entry: "create", steps: ["validate", "persist"] }],
    tests: [{ path: "test/widget.test.ts", layer: "integration", target: "create", assertions: ["creates a widget"] }],
  }),
  "plan.json": JSON.stringify({
    meta: { slug, intent: "stub intent", agent: "claude" },
    slices: [{ id: "s1", title: "Tracer", demo: "create a widget", tracer: true, criteria: ["widget created"], nodes: ["n1", "n2"] }],
    nodes: [
      { id: "n1", title: "implement create", slice: "s1", kind: "implement", deps: [], command: { program: "true", args: [] },
        role: { name: "impl", systemPrompt: "own src/widget.ts", writeBoundary: ["src/widget.ts"] } },
      { id: "n2", title: "integration check", slice: "s1", kind: "integration", deps: ["n1"], command: { program: "true", args: [] },
        role: { name: "int", systemPrompt: "verify wiring", writeBoundary: ["test/widget.test.ts"] } },
    ],
  }),
};

for (const path of paths) {
  const name = basename(path);
  if (judgeRun && !name.startsWith("audit-")) continue;
  let body = content[name];
  if (!body && name.startsWith("audit-")) {
    const persona = name.slice(6, -5);
    body = JSON.stringify({
      name: persona.charAt(0).toUpperCase() + persona.slice(1),
      lens: "stub lens",
      verdict: "approve",
      confidence: "high",
      findings: [{ severity: "P2", claim: "naming could be clearer", target: "## Components", fix: "rename" }],
    });
  }
  if (!body) continue;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}
console.log("RESULT: pass");
`;

function astra(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [BIN, ...args], { cwd, env, timeout: 60_000 }, (err, stdout, stderr) =>
      resolvePromise({ code: err?.code ?? 0, stdout, stderr }),
    );
  });
}

/** Fresh repo with the stub agent CLI first on PATH. */
async function sandbox() {
  const cwd = await mkdtemp(join(tmpdir(), "astra-e2e-"));
  const home = await mkdtemp(join(tmpdir(), "astra-e2e-home-"));
  const binDir = join(cwd, "fakebin");
  await mkdir(binDir, { recursive: true });
  const stub = join(binDir, "claude");
  await writeFile(stub, STUB);
  await chmod(stub, 0o755);

  return {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      HOME: home,
      ASTRA_HUMAN: "1",
      ASTRA_TEST_SLUG: "widget-tracking",
      PATH: `${binDir}:${process.env.PATH}`,
    },
  };
}

test("full five-gate run against a stub agent CLI", async () => {
  const { cwd, env } = await sandbox();

  const started = await astra(["start", "widget tracking", "--agent", "claude", "--judge", "magi"], { cwd, env });
  assert.equal(started.code, 0, started.stderr);

  const root = join(cwd, ".astra", "widget-tracking");
  const phases = ["product", "architecture", "design", "plan", "execute"];

  for (const phase of phases) {
    const run = await astra(["run"], { cwd, env });
    assert.equal(run.code, 0, `gate ${phase} failed: ${run.stdout}\n${run.stderr}`);

    if (phase === "architecture") {
      // Checked here rather than at the end: the stub rewrites every path named in a prompt, so a
      // later gate would clobber Gate 2's artifacts in a way a real agent is instructed not to.
      const arch = JSON.parse(await readFile(join(root, "json", "system-architecture.json"), "utf8"));
      assert.equal(arch.riskFlags.length, 3, "findings are merged back beside the design");
    }

    const approved = await astra(["approve", phase], { cwd, env });
    assert.equal(approved.code, 0, approved.stderr);

    const advanced = await astra(["advance"], { cwd, env });
    assert.equal(advanced.code, 0, advanced.stderr);
  }

  const ledger = JSON.parse(await readFile(join(root, "status.json"), "utf8"));
  assert.equal(ledger.complete, true);
  assert.ok(phases.every((p) => ledger.gates[p].status === "cleared"));

  const audit = JSON.parse(await readFile(join(root, "json", "audit.json"), "utf8"));
  assert.equal(audit.meta.mode, "magi");
  assert.deepEqual(audit.personas.map((p) => p.name).sort(), ["Balthasar", "Casper", "Melchior"]);
  assert.equal(audit.verdict, "approve", "P2-only findings approve");

  const execution = JSON.parse(await readFile(join(root, "json", "dag-execution.json"), "utf8"));
  assert.equal(execution.status, "passed");

  const status = await readFile(join(root, "00-status.md"), "utf8");
  assert.match(status, /Testing Trophy Execution/);
  assert.match(status, /cleared/);
});

test("gate 5 runs on the langgraph runtime end to end", async () => {
  const { cwd, env } = await sandbox();

  const started = await astra(
    ["start", "widget tracking", "--agent", "claude", "--runtime", "langgraph"],
    { cwd, env },
  );
  assert.equal(started.code, 0, started.stderr);

  for (const phase of ["product", "architecture", "design", "plan", "execute"]) {
    const run = await astra(["run"], { cwd, env });
    assert.equal(run.code, 0, `gate ${phase} failed: ${run.stdout}\n${run.stderr}`);
    if (phase === "execute") assert.match(run.stdout, /runtime langgraph/);
    assert.equal((await astra(["approve", phase], { cwd, env })).code, 0);
    assert.equal((await astra(["advance"], { cwd, env })).code, 0);
  }

  const root = join(cwd, ".astra", "widget-tracking");
  const execution = JSON.parse(await readFile(join(root, "json", "dag-execution.json"), "utf8"));
  assert.equal(execution.status, "passed");
  assert.equal(execution.meta.runtime ?? "langgraph", "langgraph");
  assert.deepEqual(
    execution.nodes.map((n) => n.status),
    ["passed", "passed"],
  );
});
