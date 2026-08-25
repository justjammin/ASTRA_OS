import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMcpServer } from "../lib/mcp-server.mjs";
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
    ["astra_start", "astra_status", "astra_run", "astra_approve", "astra_respond", "astra_complete", "astra_session"],
  );
});

test("start/status/session use the shared ledger and direct astra aliases", async () => {
  const cwd = await project();
  const server = createMcpServer({ cwd });

  const started = await request(server, 1, "astra/start", { intent: "MCP widget", agent: "claude" });
  assert.equal(started.result.ok, true);
  assert.equal(started.result.phase, "product");
  assert.equal(started.result.runId, "mcp-widget");

  const status = await request(server, 2, "tools/call", { name: "astra_status", arguments: {} });
  assert.equal(status.result.isError, false);
  assert.equal(status.result.structuredContent.ledger.phase, "product");
  assert.equal(status.result.structuredContent.validation.ok, false);

  const sessions = await request(server, 3, "astra/session", { action: "list" });
  assert.equal(sessions.result.runs.length, 1);
  assert.equal(sessions.result.runs[0].runId, "mcp-widget");
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

