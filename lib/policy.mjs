import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentId, InteractionRequest, InteractionResponse, ParentAgentEvent, parseRuntime } from "./schemas/runtime.mjs";
import { ensureDir, nowIso, writeJson } from "./util.mjs";

const HIGH_RISK = [
  [/\brm\s+-[^\n]*r[^\n]*/i, "recursive removal"],
  [/\b(?:sudo|doas|su)\b/i, "privilege escalation"],
  [/\b(?:chmod|chown)\s+[^\n]*(?:777|666|-R)/i, "broad permission change"],
  [/\bgit\s+(?:push\s+[^\n]*--force|reset\s+--hard|clean\s+-[^\n]*f)/i, "destructive git operation"],
  [/(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|zsh|fish)\b/i, "remote content piped to shell"],
  [/(?:\$\([^)]*\)|`[^`]+`)/, "shell substitution"],
  [/\b(?:mkfs|dd\s+if=|diskutil\s+(?:erase|partitionDisk))\b/i, "disk mutation"],
  [/>\s*\/dev\/(?:disk|sd[a-z])/i, "direct device write"],
];

const MEDIUM_RISK = [
  [/\b(?:npm|pnpm|yarn|brew|apt|apk|pip|cargo)\s+(?:install|remove|uninstall|update)\b/i, "package or system mutation"],
  [/\b(?:ssh|scp|rsync|nc|netcat)\b/i, "remote or network operation"],
  [/\b(?:env|printenv|security|keychain|aws|gcloud|az)\b/i, "potential credential access"],
];

export const ADAPTER_CAPABILITIES = Object.freeze({
  claude: { supportsPty: false, supportsCommandEvents: false, supportsInput: false, supportsNativeApproval: false, fallbackPolicy: "fail-closed" },
  opencode: { supportsPty: false, supportsCommandEvents: false, supportsInput: false, supportsNativeApproval: false, fallbackPolicy: "fail-closed" },
  codex: { supportsPty: false, supportsCommandEvents: false, supportsInput: false, supportsNativeApproval: false, fallbackPolicy: "fail-closed" },
  droid: { supportsPty: false, supportsCommandEvents: false, supportsInput: false, supportsNativeApproval: false, fallbackPolicy: "fail-closed" },
  hermes: { supportsPty: false, supportsCommandEvents: false, supportsInput: false, supportsNativeApproval: false, fallbackPolicy: "fail-closed" },
  pi: { supportsPty: false, supportsCommandEvents: true, supportsInput: false, supportsNativeApproval: false, fallbackPolicy: "fail-closed" },
});

export function classifyCommand({ agent, command, cwd = ".", source = "gate5-node" }) {
  const parsedAgent = AgentId.safeParse(agent);
  if (!parsedAgent.success) return { decision: "deny", risk: "critical", reasons: ["unsupported agent"], normalizedCommand: String(command ?? "") };
  const normalizedCommand = String(command ?? "").trim();
  if (!normalizedCommand) return { decision: "deny", risk: "high", reasons: ["empty command"], normalizedCommand };

  const high = HIGH_RISK.filter(([pattern]) => pattern.test(normalizedCommand)).map(([, reason]) => reason);
  if (high.length) return { decision: "wait", risk: "high", reasons: high.concat(`${source} in ${cwd}`), normalizedCommand };
  const medium = MEDIUM_RISK.filter(([pattern]) => pattern.test(normalizedCommand)).map(([, reason]) => reason);
  if (medium.length) return { decision: "wait", risk: "medium", reasons: medium.concat(`${source} in ${cwd}`), normalizedCommand };
  return { decision: "allow", risk: "low", reasons: [], normalizedCommand };
}

export function interactionPath(root) { return join(root, "json", "interaction.json"); }

export async function createInteraction(root, input) {
  const now = nowIso();
  const request = InteractionRequest.parse({
    ...input,
    requestId: input.requestId ?? randomUUID(),
    status: "waiting",
    resumeToken: input.resumeToken ?? randomUUID(),
    createdAt: now,
    updatedAt: now,
  });
  await writeJson(interactionPath(root), request);
  return request;
}

export async function readInteraction(root) {
  try { return InteractionRequest.parse(JSON.parse(await readFile(interactionPath(root), "utf8"))); }
  catch { return null; }
}

export async function respondInteraction(root, input) {
  const parsed = parseRuntime(InteractionResponse, input);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const current = await readInteraction(root);
  if (!current) return { ok: false, errors: ["no pending interaction"] };
  if (current.status !== "waiting") return { ok: false, errors: ["interaction is already resolved"] };
  if (current.requestId !== parsed.data.requestId || current.resumeToken !== parsed.data.resumeToken) {
    return { ok: false, errors: ["request id or resume token does not match"] };
  }
  const status = parsed.data.action === "approve" ? "approved" : parsed.data.action === "deny" ? "denied" : "answered";
  const next = InteractionRequest.parse({ ...current, status, updatedAt: nowIso(), response: { action: parsed.data.action, ...(parsed.data.value ? { value: parsed.data.value } : {}), respondedAt: nowIso() } });
  await writeJson(interactionPath(root), next);
  return { ok: true, data: next };
}

export async function waitForInteraction(root, { timeoutMs = 30 * 60 * 1000, intervalMs = 250 } = {}) {
  const started = Date.now();
  for (;;) {
    const current = await readInteraction(root);
    if (current && current.status !== "waiting") return current;
    if (Date.now() - started >= timeoutMs) return { status: "denied", response: { action: "deny", value: "interaction timed out", respondedAt: nowIso() } };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function parentEvent(request, event = request.kind === "command-approval" ? "WAITING_FOR_APPROVAL" : "WAITING_FOR_INPUT") {
  return ParentAgentEvent.parse({ event, requestId: request.requestId, runId: request.runId, resumeToken: request.resumeToken, agent: request.agent, kind: request.kind, summary: request.summary, risk: request.risk });
}

export async function emitParentEvent(root, request, event) {
  const payload = `${JSON.stringify(parentEvent(request, event))}\n`;
  await ensureDir(join(root, "logs"));
  await appendFile(join(root, "logs", "interactions.jsonl"), payload, "utf8");
  process.stdout.write(payload);
}
