import { z } from "zod";

export const AgentId = z.enum(["claude", "opencode", "codex", "droid", "hermes", "pi"]);
export const Risk = z.enum(["low", "medium", "high", "critical"]);
export const PolicyDecision = z.enum(["allow", "deny", "wait"]);
export const InteractionKind = z.enum(["command-approval", "agent-input", "agent-wait"]);
export const InteractionStatus = z.enum(["idle", "waiting", "approved", "denied", "answered", "completed"]);

export const AdapterCapabilities = z.object({
  supportsPty: z.boolean(),
  supportsCommandEvents: z.boolean(),
  supportsInput: z.boolean(),
  supportsNativeApproval: z.boolean(),
  fallbackPolicy: z.enum(["restricted", "fail-closed"]),
}).strict();

export const PolicyResult = z.object({
  decision: PolicyDecision,
  risk: Risk,
  reasons: z.array(z.string()),
  normalizedCommand: z.string(),
}).strict();

export const InteractionRequest = z.object({
  requestId: z.string().min(1),
  runId: z.string().min(1),
  kind: InteractionKind,
  status: InteractionStatus,
  agent: AgentId,
  source: z.enum(["adapter", "gate5-node"]),
  risk: Risk,
  summary: z.string().min(1),
  command: z.string().optional(),
  question: z.string().optional(),
  cwd: z.string().optional(),
  node: z.string().optional(),
  gate: z.string().optional(),
  resumeToken: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  response: z.object({
    action: z.enum(["approve", "deny", "answer"]),
    value: z.string().optional(),
    respondedAt: z.string(),
  }).strict().optional(),
}).strict();

export const InteractionResponse = z.object({
  requestId: z.string().min(1),
  resumeToken: z.string().min(1),
  action: z.enum(["approve", "deny", "answer"]),
  value: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === "answer" && !value.value?.trim()) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "answer requires a non-empty value" });
  }
});

export const ParentAgentEvent = z.object({
  event: z.enum(["WAITING_FOR_APPROVAL", "WAITING_FOR_INPUT", "INTERACTION_RESOLVED"]),
  requestId: z.string().min(1),
  runId: z.string().min(1),
  resumeToken: z.string().min(1),
  agent: AgentId,
  kind: InteractionKind,
  summary: z.string().min(1),
  risk: Risk,
}).strict();

export const FeedbackBody = z.object({
  gate: z.enum(["product", "architecture", "design", "plan", "execute"]),
  verdict: z.enum(["approved", "changes-requested"]),
  notes: z.string().optional(),
  findings: z.array(z.object({
    severity: z.enum(["P0", "P1", "P2"]),
    claim: z.string(),
    fix: z.string(),
  }).strict()).optional(),
}).strict();

export function parseRuntime(schema, value) {
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, data: result.data, errors: [] }
    : { ok: false, data: null, errors: result.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`) };
}
