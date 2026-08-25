import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "astra.mjs");

function astra(args, { cwd, env = {} }) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd, env: { ...process.env, NO_COLOR: "1", ...env } },
      (err, stdout, stderr) => resolvePromise({ code: err?.code ?? 0, stdout, stderr }),
    );
  });
}

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "astra-cli-"));
  const home = await mkdtemp(join(tmpdir(), "astra-home-"));
  return { dir, env: { HOME: home, ASTRA_HUMAN: "1" } };
}

async function writeProductArtifacts(root) {
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "json"), { recursive: true });
  await writeFile(join(root, "docs", "01-product.md"), `# Thing\n${"detail ".repeat(120)}`);
  await writeFile(
    join(root, "json", "ui-layout.json"),
    JSON.stringify({
      meta: { slug: "add-a-widget", intent: "add a widget" },
      screens: [
        { id: "u1", name: "Widget list", purpose: "see widgets", elements: [{ type: "table", label: "Widgets" }], acceptance: ["lists widgets"] },
      ],
    }),
  );
}

test("--help exits clean and lists the gates", async () => {
  const { dir, env } = await repo();
  const res = await astra(["--help"], { cwd: dir, env });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /1:product\s+2:architecture\s+3:design\s+4:plan\s+5:execute/);
});

test("commands refuse without an active run", async () => {
  const { dir, env } = await repo();
  const res = await astra(["status"], { cwd: dir, env });
  assert.equal(res.code, 3);
  assert.match(res.stderr, /no run in this repository/);
});

test("start writes the ledger, then gate/approve/advance walk the phases", async () => {
  const { dir, env } = await repo();

  const started = await astra(["start", "add a widget", "--agent", "claude", "--judge", "magi", "--budget-tokens", "50000"], { cwd: dir, env });
  assert.equal(started.code, 0);
  assert.match(started.stdout, /ASTRA READY/);
  assert.match(started.stdout, /judge     magi/);

  const root = join(dir, ".astra", "add-a-widget");
  const ledger = JSON.parse(await readFile(join(root, "status.json"), "utf8"));
  assert.equal(ledger.phase, "product");
  assert.equal(ledger.meta.agent, "claude");
  const session = JSON.parse(await readFile(join(root, "json", "session.json"), "utf8"));
  assert.equal(session.harness, "claude");
  assert.equal(session.interface, "tui");
  assert.equal(session.budget.budgetTokens, 50000);
  assert.match(await readFile(join(root, "00-status.md"), "utf8"), /Product Intent & Visual Spec/);

  const second = await astra(["start", "another idea"], { cwd: dir, env });
  assert.equal(second.code, 3, "a second run cannot start while one is active");

  const failing = await astra(["gate", "product"], { cwd: dir, env });
  assert.equal(failing.code, 1);
  assert.match(failing.stdout, /docs\/01-product\.md/);

  const earlyApprove = await astra(["approve", "product"], { cwd: dir, env });
  assert.equal(earlyApprove.code, 1, "cannot approve invalid artifacts");

  await writeProductArtifacts(root);

  const passing = await astra(["gate", "product"], { cwd: dir, env });
  assert.equal(passing.code, 0);

  const blockedAdvance = await astra(["advance"], { cwd: dir, env });
  assert.equal(blockedAdvance.code, 3, "advance refuses while the gate is unclear");

  const agentApprove = await astra(["approve", "product"], { cwd: dir, env: { ...env, ASTRA_HUMAN: "0" } });
  assert.equal(agentApprove.code, 4, "clearing a gate is human-only");
  assert.match(agentApprove.stderr, /human's decision/);

  assert.equal((await astra(["approve", "product"], { cwd: dir, env })).code, 0);
  const advanced = await astra(["advance"], { cwd: dir, env });
  assert.equal(advanced.code, 0);
  assert.match(advanced.stdout, /phase 2\/5/);

  const loopForward = await astra(["loop", "--to=execute", "--reason=nope"], { cwd: dir, env });
  assert.equal(loopForward.code, 3);

  const looped = await astra(["loop", "--to=product", "--reason=intent changed"], { cwd: dir, env });
  assert.equal(looped.code, 0);
  const after = JSON.parse(await readFile(join(root, "status.json"), "utf8"));
  assert.equal(after.phase, "product");
  assert.equal(after.gates.architecture.status, "pending");
  assert.equal(after.gates.product.loops, 1);
});

test("run --dry-run composes the invocation without spawning an agent", async () => {
  const { dir, env } = await repo();
  await astra(["start", "dry idea"], { cwd: dir, env });
  const res = await astra(["run", "--dry-run"], { cwd: dir, env });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /dry run/);
});

test("doctor reports adapters and roles scan builds a map", async () => {
  const { dir, env } = await repo();
  const doctor = await astra(["doctor"], { cwd: dir, env });
  assert.equal(doctor.code, 0);
  for (const id of ["claude", "droid", "opencode", "hermes", "codex"]) {
    assert.match(doctor.stdout, new RegExp(id));
  }

  const scanned = await astra(["roles", "scan"], { cwd: dir, env });
  assert.equal(scanned.code, 0);
  const index = JSON.parse(await readFile(join(env.HOME, ".astra", "map", "index.json"), "utf8"));
  assert.ok(Object.keys(index.domains).length > 0);

  const listed = await astra(["roles", "list"], { cwd: dir, env });
  assert.equal(listed.code, 0);
});

test("unknown gate and unknown agent are rejected with usage-level errors", async () => {
  const { dir, env } = await repo();
  const badAgent = await astra(["start", "x", "--agent", "gpt5"], { cwd: dir, env });
  assert.equal(badAgent.code, 1);
  assert.match(badAgent.stderr, /unknown agent/);

  await astra(["start", "real intent"], { cwd: dir, env });
  const badGate = await astra(["run", "--gate", "nope"], { cwd: dir, env });
  assert.equal(badGate.code, 1);
  assert.match(badGate.stderr, /unknown gate/);
});

test("start validates budget and session reports the harness route", async () => {
  const { dir, env } = await repo();
  const invalid = await astra(["start", "budget demo", "--budget-tokens", "nope"], { cwd: dir, env });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /positive integer/);
  await astra(["start", "budget demo", "--agent", "codex", "--budget-tokens", "1000"], { cwd: dir, env });
  const session = await astra(["session"], { cwd: dir, env });
  assert.equal(session.code, 0);
  assert.match(session.stdout, /session → codex → TUI/i);
  assert.match(session.stdout, /0 \/ 1,000 tokens/);
});
