import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { createMcpServer, serveStdio } from "../lib/mcp-server.mjs";
import { createInteraction } from "../lib/policy.mjs";

async function project() {
  return mkdtemp(join(tmpdir(), "astra-mcp-"));
}

async function request(server, id, method, params) {
  const response = await server.handleRequest({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
  assert.equal(response.jsonrpc, "2.0");
  return response;
}

test("MCP initialize and tools/list expose the Astra contract without CLI side effects", async () => {
  const cwd = await project();
  const server = createMcpServer({ cwd });

  const initialized = await request(server, 1, "initialize", { protocolVersion: "2025-06-18" });
  assert.equal(initialized.result.serverInfo.name, "astra-os");
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });

  const listed = await request(server, 2, "tools/list");
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [
      "astra_start",
      "astra_check",
      "astra_status",
      "astra_run",
      "astra_gate",
      "astra_advance",
      "astra_loop",
      "astra_visualizer",
      "astra_approve",
      "astra_respond",
      "astra_complete",
      "astra_session",
    ],
  );
});

test("gate prepares host-native packets without invoking the pipeline", async () => {
  const cwd = await project();
  let pipelineCalls = 0;
  const server = createMcpServer({
    cwd,
    runDesignGate: async () => { pipelineCalls += 1; throw new Error("pipeline must not run"); },
    runExecution: async () => { pipelineCalls += 1; throw new Error("pipeline must not run"); },
  });
  await request(server, 1, "astra_start", { intent: "native gate packet" });

  const gate = await request(server, 2, "tools/call", { name: "astra_gate", arguments: {} });
  assert.equal(gate.result.isError, false);
  assert.equal(gate.result.structuredContent.gate.id, "product");
  assert.match(gate.result.structuredContent.prompt, /Product Architect Agent/);
  assert.equal(typeof gate.result.structuredContent.contracts[1].schema, "object");
  assert.equal(pipelineCalls, 0);

  const ledgerPath = join(gate.result.structuredContent.root, "status.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.gates.product.status = "cleared";
  await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`);
  await request(server, 3, "astra_advance", {});
  const architecture = await request(server, 4, "astra/gate", { gate: "architecture", judge: "magi" });
  assert.equal(architecture.result.reviewerPackets.length, 3);
  assert.match(architecture.result.reviewerPackets[0].prompt, /adversarial reviewer/);
  assert.equal(pipelineCalls, 0);
});

test("visualizer MCP operation owns a start/status/stop lifecycle", async () => {
  const cwd = await project();
  let closes = 0;
  const server = createMcpServer({
    cwd,
    startVisualizer: async ({ runRoot, port, open }) => {
      assert.equal(port, 0);
      assert.equal(open, false);
      return { url: "http://127.0.0.1:4321", close: async () => { closes += 1; } };
    },
  });
  const started = await request(server, 1, "astra_start", { intent: "visualizer lifecycle" });

  const initial = await request(server, 2, "tools/call", { name: "astra_visualizer", arguments: { action: "status" } });
  assert.equal(initial.result.structuredContent.running, false);

  const running = await request(server, 3, "astra/visualizer", { action: "start", port: 0 });
  assert.equal(running.result.ok, true);
  assert.equal(running.result.url, "http://127.0.0.1:4321");

  const status = await request(server, 4, "astra_visualizer", { action: "status" });
  assert.equal(status.result.running, true);
  assert.equal(status.result.url, running.result.url);

  const stopped = await request(server, 5, "tools/call", { name: "astra_visualizer", arguments: { action: "stop" } });
  assert.equal(stopped.result.structuredContent.running, false);
  assert.equal(closes, 1);
  await server.close();
  void started;
});

test("Gate 5 gate packet renders the selected node contract", async () => {
  const cwd = await project();
  const server = createMcpServer({ cwd });
  const started = await request(server, 1, "astra_start", { intent: "node packet" });
  const ledgerPath = join(started.result.root, "status.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.phase = "execute";
  for (const state of Object.values(ledger.gates)) state.status = "cleared";
  await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`);
  await mkdir(join(started.result.root, "json"), { recursive: true });
  await writeFile(join(started.result.root, "json/plan.json"), `${JSON.stringify({
    meta: { slug: started.result.slug, intent: started.result.intent, agent: "claude" },
    slices: [{ id: "s1", title: "Tracer", demo: "works", tracer: true, criteria: ["works"], nodes: ["n1"] }],
    nodes: [{
      id: "n1",
      title: "Verify packet",
      slice: "s1",
      kind: "unit",
      deps: [],
      role: { name: "Unit verifier", systemPrompt: "Verify it", writeBoundary: ["test"] },
      assertions: ["assert it"],
    }],
  })}\n`);

  const packet = await request(server, 2, "tools/call", { name: "astra_gate", arguments: { nodeId: "n1" } });
  assert.equal(packet.result.isError, false);
  assert.equal(packet.result.structuredContent.nodePacket.node.id, "n1");
  assert.match(packet.result.structuredContent.nodePacket.prompt, /Verify packet/);
});

test("advance and loop stay ledger-gated and bounded", async () => {
  const cwd = await project();
  const server = createMcpServer({ cwd });
  const started = await request(server, 1, "astra_start", { intent: "transitions" });
  const ledgerPath = join(started.result.root, "status.json");
  const setGate = async (gate, status) => {
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger.gates[gate].status = status;
    await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`);
  };

  const refused = await request(server, 2, "astra_advance", {});
  assert.equal(refused.error.code, -32001);
  assert.match(refused.error.message, /not cleared/);

  await setGate("product", "cleared");
  const advanced = await request(server, 3, "astra_advance", {});
  assert.equal(advanced.result.phase, "architecture");

  const looped = await request(server, 4, "astra_loop", { to: "product", reason: "revise intent" });
  assert.equal(looped.result.phase, "product");
  assert.equal(looped.result.ledger.gates.product.loops, 1);
  assert.equal(looped.result.ledger.gates.architecture.status, "pending");
  const loopedAgain = await request(server, 5, "astra_loop", { to: "product", reason: "revise again" });
  assert.equal(loopedAgain.result.ledger.gates.product.loops, 2);
  const exhausted = await request(server, 6, "astra_loop", { to: "product", reason: "stop" });
  assert.equal(exhausted.error.code, -32001);
  assert.match(exhausted.error.message, /loop budget exhausted/);

  for (const gate of ["product", "architecture", "design", "plan", "execute"]) {
    await setGate(gate, "cleared");
    const result = await request(server, 7, "astra_advance", {});
    if (gate === "execute") {
      assert.equal(result.result.complete, true);
      assert.equal(result.result.ledger.complete, true);
    }
  }
});

test("start/status/session use the shared ledger and direct astra aliases", async () => {
  const cwd = await project();
  const server = createMcpServer({ cwd });

  const started = await request(server, 1, "astra/start", { intent: "MCP widget", agent: "claude" });
  assert.equal(started.result.ok, true);
  assert.equal(started.result.phase, "product");
  assert.equal(started.result.runId, "mcp-widget");

  const check = await request(server, 2, "tools/call", { name: "astra_check", arguments: {} });
  assert.equal(check.result.isError, false);
  assert.equal(check.result.structuredContent.ledger.phase, "product");
  assert.equal(check.result.structuredContent.validation.ok, false);

  const status = await request(server, 4, "astra_status", {});
  assert.equal(status.result.phase, check.result.structuredContent.phase);

  const sessions = await request(server, 3, "astra/session", { action: "list" });
  assert.equal(sessions.result.runs.length, 1);
  assert.equal(sessions.result.runs[0].runId, "mcp-widget");
});

test("start refuses to overwrite an existing explicit root", async () => {
  const cwd = await project();
  const server = createMcpServer({ cwd });
  const started = await request(server, 1, "astra_start", { intent: "original", out: "runs/fixed" });
  await request(server, 2, "astra_complete", {});

  const refused = await request(server, 3, "astra_start", { intent: "replacement", out: started.result.root });
  assert.equal(refused.error.code, -32001);
  assert.match(refused.error.message, /already exists/);
  const ledger = JSON.parse(await readFile(join(started.result.root, "status.json"), "utf8"));
  assert.equal(ledger.meta.intent, "original");
});

test("gate IDs are safe and approvals stay on the current phase", async () => {
  const cwd = await project();
  const server = createMcpServer({ cwd });
  await request(server, 1, "astra_start", { intent: "gate validation" });

  const gate = await request(server, 2, "astra_gate", { gate: "not-a-gate" });
  assert.equal(gate.error.code, -32602);
  const loop = await request(server, 3, "astra_loop", { to: "not-a-gate", reason: "bad input" });
  assert.equal(loop.error.code, -32602);
  const approve = await request(server, 4, "astra_approve", { gate: "not-a-gate", human: true });
  assert.equal(approve.error.code, -32602);
  const run = await request(server, 5, "astra_run", { gate: "not-a-gate" });
  assert.equal(run.error.code, -32602);

  const mismatch = await request(server, 6, "astra_approve", { gate: "architecture", human: true });
  assert.equal(mismatch.error.code, -32001);
  assert.match(mismatch.error.message, /ledger is at "product"/);
});

test("run persists gate state while approval remains explicitly human-only", async () => {
  const cwd = await project();
  const server = createMcpServer({
    cwd,
    runDesignGate: async (_ctx, gateId) => ({ ok: true, detail: `stub ${gateId}` }),
  });
  await request(server, 1, "astra_start", { intent: "stub run" });

  const dry = await request(server, 2, "tools/call", { name: "astra_run", arguments: { dryRun: true } });
  assert.equal(dry.result.isError, false);
  assert.equal(dry.result.structuredContent.dryRun, true);

  const ran = await request(server, 3, "astra/run", {});
  assert.equal(ran.result.ok, true);
  assert.equal(ran.result.ledger.gates.product.status, "ran");

  const denied = await request(server, 4, "tools/call", { name: "astra_approve", arguments: { gate: "product" } });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /human:true/);

  const approved = await request(server, 5, "astra/approve", { gate: "product", human: true });
  assert.equal(approved.error.code, -32001);
  assert.match(approved.error.message, /artifacts are invalid/);
});

test("MCP run results preserve host harness failures", async () => {
  const cwd = await project();
  const server = createMcpServer({
    cwd,
    runDesignGate: async () => ({ ok: false, harnessFailure: true, detail: "OpenPencil unavailable" }),
  });
  await request(server, 1, "astra_start", { intent: "materialization failure" });
  const failed = await request(server, 2, "astra_run", {});
  assert.equal(failed.result.ok, false);
  assert.equal(failed.result.harnessFailure, true);
  assert.equal(failed.result.gates[0].harnessFailure, true);
  assert.match(failed.result.gates[0].detail, /OpenPencil unavailable/);
});

test("respond requires the interaction token and resolves a pending request", async () => {
  const cwd = await project();
  const server = createMcpServer({ cwd });
  const started = await request(server, 1, "astra_start", { intent: "interaction" });
  const root = started.result.root;
  const interaction = await createInteraction(root, {
    runId: started.result.runId,
    kind: "command-approval",
    agent: "claude",
    source: "gate5-node",
    risk: "medium",
    summary: "test approval",
    command: "echo safe",
  });

  const missingToken = await request(server, 2, "tools/call", {
    name: "astra_respond",
    arguments: { requestId: interaction.requestId, action: "deny" },
  });
  assert.equal(missingToken.result.isError, true);
  assert.match(missingToken.result.content[0].text, /resumeToken is required/);

  const resolved = await request(server, 3, "astra/respond", {
    requestId: interaction.requestId,
    resumeToken: interaction.resumeToken,
    action: "deny",
  });
  assert.equal(resolved.result.ok, true);
  assert.equal(resolved.result.interaction.status, "denied");
  const saved = JSON.parse(await readFile(join(root, "json", "interaction.json"), "utf8"));
  assert.equal(saved.status, "denied");
});

test("JSON-RPC notifications, batches, and unknown methods stay protocol-safe", async () => {
  const cwd = await project();
  const server = createMcpServer({ cwd });

  assert.equal(await server.handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const batch = await server.handleRequest([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "does-not-exist" },
  ]);
  assert.equal(batch.length, 2);
  assert.deepEqual(batch[0].result, {});
  assert.equal(batch[1].error.code, -32601);

  const malformed = await server.handleRequest({ id: 4, method: "ping" });
  assert.equal(malformed.error.code, -32600);
});

test("stdio transport closes the server during teardown", async () => {
  let closed = 0;
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const server = {
    async handleRequest(request) {
      return { jsonrpc: "2.0", id: request.id, result: {} };
    },
    async close() {
      closed += 1;
    },
  };
  await serveStdio({
    server,
    input: Readable.from([`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`]),
    output,
  });
  assert.equal(closed, 1);
  assert.match(chunks.join(""), /"id":1/);
});
