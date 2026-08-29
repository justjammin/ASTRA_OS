import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { relative } from "node:path";
import { artifact, logPath, REL } from "./paths.mjs";
import { checkGate, getGate } from "./gates.mjs";
import { renderPrompt, schemaText } from "./prompt.mjs";
import { invoke } from "./adapters.mjs";
import { personasFor } from "./personas.mjs";
import { collect, personaFile } from "./tribunal.mjs";
import { createExecution } from "./execution.mjs";
import { getRuntime } from "./runtime/index.mjs";
import { personaBlock, roleForGate, roleForNode, roleForPersona, suggestSpecialist } from "./rolemap.mjs";
import { ensureDir, readJson, style } from "./util.mjs";
import { beginWorker, finishWorker, loadSession, recordUsage } from "./broker.mjs";
import { deriveCoordinatorPolicy, deriveDagWorkerPolicy, deriveJudgePolicy, deriveScoutPolicy } from "./execution-policy.mjs";
import { createCommandSandbox, SandboxUnavailableError } from "./sandbox.mjs";
import { materializeUserStory } from "./user-story-materializer.mjs";

const SCHEMA_VARS = {
  USER_STORY_SCHEMA: "user-story",
  SYSTEM_ARCH_SCHEMA: "system-architecture",
  CALL_STACK_SCHEMA: "call-stack-types",
  PLAN_SCHEMA: "plan",
};

/** Prompt-visible paths are relative to the repo so the agent can act on them verbatim. */
function pathVars(ctx) {
  const rel = (key) => relative(ctx.cwd, artifact(ctx.root, key)) || REL[key];
  return {
    PRODUCT_PATH: rel("product"),
    USER_STORY_PATH: rel("userStory"),
    ARCHITECTURE_PATH: rel("architecture"),
    PROGRAM_DESIGN_PATH: rel("programDesign"),
    SLICES_PATH: rel("slices"),
    PLAN_PATH: rel("plan"),
    SYSTEM_ARCH_PATH: rel("systemArchitecture"),
    CALL_STACK_TYPES_PATH: rel("callStackTypes"),
    AUDIT_PATH: rel("auditJson"),
    DAG_PATH: rel("dag"),
  };
}

async function baseVars(ctx) {
  const vars = {
    ...pathVars(ctx),
    INTENT: ctx.intent,
    SLUG: ctx.slug,
    AGENT: ctx.agent,
    CWD: ctx.cwd,
  };
  for (const [token, schema] of Object.entries(SCHEMA_VARS)) {
    vars[token] = await schemaText(schema);
  }
  return vars;
}

/** Prepare a gate prompt for a host-native caller without invoking an adapter. */
export async function prepareGatePrompt(ctx, gateId) {
  const gate = getGate(gateId);
  const vars = await baseVars(ctx);
  const role = await roleForGate(gate.id);
  return {
    gate: { id: gate.id, n: gate.n, name: gate.name },
    prompt: await renderPrompt(gate.prompt, vars),
    role: role ? personaBlock(role) : "",
    roleName: role?.name ?? gate.role,
  };
}

/** Prepare Gate 2's independent reviewer packets without running reviewers. */
export async function prepareReviewerPackets(ctx) {
  const vars = await baseVars(ctx);
  const personas = personasFor(ctx.judge ?? "solo");
  return Promise.all(personas.map(async (persona) => {
    const role = await roleForPersona(persona.name);
    const out = personaFile(ctx.root, persona.name);
    return {
      name: persona.name,
      lens: persona.lens,
      brief: persona.brief,
      outputPath: relative(ctx.cwd, out),
      prompt: await renderPrompt("gate2-judge.md", {
        ...vars,
        PERSONA_NAME: persona.name,
        PERSONA_LENS: persona.lens,
        PERSONA_BRIEF: persona.brief,
        OUT_PATH: relative(ctx.cwd, out),
      }),
      role: role ? personaBlock(role) : "",
      roleName: role?.name ?? persona.name,
    };
  }));
}

/** Prepare one Gate 5 node packet for a host-native worker without executing it. */
export async function prepareNodePacket(ctx, nodeId) {
  const plan = await readJson(artifact(ctx.root, "dag"));
  if (!plan || !Array.isArray(plan.nodes)) throw new Error("Gate 5 plan artifact is missing or invalid");
  const node = plan.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`unknown node "${nodeId}"`);
  const slice = plan.slices.find((candidate) => candidate.id === node.slice);
  const vars = await baseVars(ctx);
  const role = await roleForNode(node.kind);
  return {
    node,
    slice,
    prompt: await renderPrompt("gate5-node.md", {
      ...vars,
      ROLE_PROMPT: node.role.systemPrompt,
      NODE_ID: node.id,
      NODE_TITLE: node.title,
      NODE_KIND: node.kind,
      SLICE_ID: node.slice,
      SLICE_TITLE: slice?.title ?? node.slice,
      SLICE_CRITERIA: (slice?.criteria ?? []).map((criterion) => `- ${criterion}`).join("\n") || "- (none recorded)",
      NODE_TASK: node.task ?? node.title,
      WRITE_BOUNDARY: node.role.writeBoundary.map((path) => `- \`${path}\``).join("\n"),
      ASSERTIONS: (node.assertions ?? []).map((assertion) => `- ${assertion}`).join("\n") || "- The contract's assertions for this node's layer hold.",
    }),
    role: role ? personaBlock(role) : "",
    roleName: role?.name ?? node.role.name,
  };
}

function invokeFor(ctx) {
  return ctx.invoke ?? invoke;
}

function policyFor(ctx, profile, options = {}) {
  if (ctx.executionPolicyFactory) return ctx.executionPolicyFactory(profile, options);
  if (profile === "scout") return deriveScoutPolicy({ cwd: ctx.cwd });
  if (profile === "coordinator") return deriveCoordinatorPolicy({ cwd: ctx.cwd, artifactPaths: options.artifactPaths });
  if (profile === "judge") return deriveJudgePolicy({ cwd: ctx.cwd, auditPath: options.auditPath });
  return deriveDagWorkerPolicy({ cwd: ctx.cwd, role: options.role });
}

/**
 * Run one design gate: single agent turn, verify artifacts from disk, then at most one repair
 * turn quoting the exact validation failures. Never reports success on the agent's word.
 */
export async function runDesignGate(ctx, gateId, { log = console.log } = {}) {
  const gate = getGate(gateId);
  const vars = await baseVars(ctx);
  const role = await roleForGate(gateId);
  let prompt = await renderPrompt(gate.prompt, vars);

  await ensureDir(artifact(ctx.root, "logs").replace(/\/[^/]*$/, "/logs"));
  const file = logPath(ctx.root, `gate-${gate.n}-${gate.id}`);

  if (gateId === "product") {
    const scout = await runProductScout(ctx, { log });
    if (scout) prompt = `${prompt}\n\n## Read-only repository scout\n\nUse these observations as evidence. Verify anything consequential before relying on it.\n\n${scout}`;
  }

  log(`${style.magenta("▚")} gate ${gate.n} ${style.bold(gate.name)} — ${ctx.agent} as ${role?.name ?? gate.role}`);
  const coordinator = await coordinatorOptions(ctx);
  const executionPolicy = policyFor(ctx, "coordinator", { artifactPaths: gate.artifacts.map(({ key }) => artifact(ctx.root, key)) });
  let turn = await invokeFor(ctx)(ctx.agent, {
    prompt,
    role: personaBlock(role),
    cwd: ctx.cwd,
    workDir: ctx.root,
    logFile: file,
    dryRun: ctx.dryRun,
    timeoutMs: ctx.timeoutMs,
    sessionId: coordinator.sessionId,
    resume: coordinator.resume,
    budgetTokens: ctx.budgetTokens,
    compactAt: 0.5,
    executionPolicy,
    adapterCapabilities: ctx.adapterCapabilities,
    policyCompiler: ctx.policyCompiler,
    outerSandbox: ctx.outerSandbox,
  });
  await recordUsage(ctx.root, turn.usage ?? {});
  if (ctx.dryRun) return { ok: true, dryRun: true, argv: turn.argv, prompt };

  if (gate.judge) await runJudges(ctx, { log });

  let verdict = await checkGate(ctx.root, gateId, { expectedSlug: ctx.slug });
  if (!verdict.ok) {
    const failures = verdict.checks.filter((c) => !c.ok);
    log(`${style.amber("↻")} repair turn — ${failures.length} artifact problem(s)`);
    const repair = [
      `Your previous turn on Astra Gate ${gate.n} (${gate.name}) left artifacts that fail validation.`,
      "",
      "Failures:",
      ...failures.map((f) => `- \`${f.path}\` — ${f.detail}`),
      "",
      "Fix exactly these files. Do not restart the gate, do not rewrite passing artifacts, and do not",
      "touch anything else. The schema is authoritative: unexpected properties and missing required",
      "fields both fail. Then print the corrected file paths.",
      "",
      "Original gate instructions follow.",
      "",
      prompt,
    ].join("\n");

    const repairCoordinator = await coordinatorOptions(ctx);
    turn = await invokeFor(ctx)(ctx.agent, {
      prompt: repair,
      role: personaBlock(role),
      cwd: ctx.cwd,
      workDir: ctx.root,
      logFile: file,
      timeoutMs: ctx.timeoutMs,
      sessionId: repairCoordinator.sessionId,
      resume: repairCoordinator.resume,
      budgetTokens: ctx.budgetTokens,
      compactAt: 0.5,
      executionPolicy,
      adapterCapabilities: ctx.adapterCapabilities,
      policyCompiler: ctx.policyCompiler,
      outerSandbox: ctx.outerSandbox,
    });
    await recordUsage(ctx.root, turn.usage ?? {});
    if (gate.judge) await runJudges(ctx, { log });
    verdict = await checkGate(ctx.root, gateId, { expectedSlug: ctx.slug });
  }

  if (verdict.ok && gate.id === "product") {
    let story;
    try {
      story = await readJson(artifact(ctx.root, "userStory"));
    } catch (error) {
      // Validation already read this file. A second read failing means the host could not
      // materialize the approved contract; do not spend an agent repair turn on a host failure.
      return {
        ok: false,
        harnessFailure: true,
        detail: `Gate 1 user-story materialization could not read the validated artifact: ${error.message}`,
        checks: verdict.checks,
        exitCode: turn.code,
        logFile: file,
      };
    }

    try {
      const materializer = ctx.userStoryMaterializer ?? materializeUserStory;
      const materialized = await materializer(ctx.root, story, {
        cwd: ctx.cwd,
        timeoutMs: ctx.timeoutMs,
        execFile: ctx.openPencilExecFile,
      });
      if (materialized?.ok === false) {
        throw new Error(materialized.detail ?? "materializer returned ok:false");
      }
      return {
        ok: true,
        detail: materialized?.surface === "ui"
          ? "product and UI user-story artifacts valid; OpenPencil preview materialized"
          : "product and non-UI user-story artifacts valid",
        checks: verdict.checks,
        materialized,
        exitCode: turn.code,
        logFile: file,
      };
    } catch (error) {
      return {
        ok: false,
        harnessFailure: true,
        detail: `Gate 1 user-story materialization failed: ${error instanceof Error ? error.message : String(error)}`,
        checks: verdict.checks,
        exitCode: turn.code,
        logFile: file,
      };
    }
  }

  return { ok: verdict.ok, detail: verdict.ok ? "artifacts valid" : "artifact validation failed", checks: verdict.checks, exitCode: turn.code, logFile: file };
}

async function coordinatorOptions(ctx) {
  const session = await loadSession(ctx.root);
  const sessionId = session?.coordinator?.sessionId ?? null;
  return { sessionId, resume: Boolean(sessionId) };
}

async function runProductScout(ctx, { log }) {
  const policy = ctx.workerModel ?? {};
  const workerId = await beginWorker(ctx.root, {
    kind: "gate-1-scout",
    harness: ctx.agent,
    model: policy.model,
    effort: policy.effort,
    task: "Read-only repository reconnaissance for product intent",
  });
  log(`${style.cyan("◇")} scout repository context (${policy.model ?? "inherited model"})`);
  let turn;
  try {
    turn = await invokeFor(ctx)(ctx.agent, {
      prompt: [
        `Scout the repository for this intent: ${ctx.intent}`,
        "Read only. Do not edit files, run destructive commands, or produce gate artifacts.",
        "Return concise evidence: relevant entry points, established patterns, constraints, tests, and likely user-visible impact.",
      ].join("\n"),
      cwd: ctx.cwd,
      workDir: ctx.root,
      logFile: logPath(ctx.root, "gate-1-scout"),
      dryRun: ctx.dryRun,
      timeoutMs: ctx.timeoutMs,
      model: policy.model,
      effort: policy.effort,
      sessionKey: `worker:${workerId}`,
      executionPolicy: policyFor(ctx, "scout"),
      adapterCapabilities: ctx.adapterCapabilities,
      policyCompiler: ctx.policyCompiler,
      outerSandbox: ctx.outerSandbox,
    });
    await finishWorker(ctx.root, workerId, { ok: turn.code === 0, sessionId: turn.sessionId, usage: turn.usage, warning: turn.warning });
    return turn.stdout?.trim() || null;
  } catch (error) {
    if (/policy|capability|sandbox|auto launch/i.test(error.message)) throw error;
    await finishWorker(ctx.root, workerId, { ok: false, warning: `Gate 1 scout unavailable: ${error.message}` });
    log(`${style.amber("!")} scout unavailable; coordinator continues`);
    return null;
  }
}

/** Gate 2 adversarial pass: solo grunt, or the three MAGI cores run independently. */
export async function runJudges(ctx, { log = console.log } = {}) {
  const mode = ctx.judge ?? "solo";
  const personas = personasFor(mode);
  const vars = await baseVars(ctx);

  await Promise.all(personas.map(async (persona) => {
    const role = await roleForPersona(persona.name);
    const out = personaFile(ctx.root, persona.name);
    const prompt = await renderPrompt("gate2-judge.md", {
      ...vars,
      PERSONA_NAME: persona.name,
      PERSONA_LENS: persona.lens,
      PERSONA_BRIEF: persona.brief,
      OUT_PATH: relative(ctx.cwd, out),
    });
    log(`${style.cyan("◆")} judge ${persona.name} (${mode})`);
    const policy = ctx.workerModel ?? {};
    const workerId = await beginWorker(ctx.root, {
      kind: `judge-${persona.name.toLowerCase()}`,
      harness: ctx.agent,
      model: policy.model,
      effort: policy.effort,
      task: persona.brief,
    });
    const turn = await invokeFor(ctx)(ctx.agent, {
      prompt,
      role: personaBlock(role),
      cwd: ctx.cwd,
      workDir: ctx.root,
      logFile: logPath(ctx.root, `gate-2-judge-${persona.name.toLowerCase()}`),
      dryRun: ctx.dryRun,
      timeoutMs: ctx.timeoutMs,
      model: policy.model,
      effort: policy.effort,
      sessionKey: `worker:${workerId}`,
      executionPolicy: policyFor(ctx, "judge", { auditPath: out }),
      adapterCapabilities: ctx.adapterCapabilities,
      policyCompiler: ctx.policyCompiler,
      outerSandbox: ctx.outerSandbox,
    });
    await finishWorker(ctx.root, workerId, { ok: turn.code === 0, sessionId: turn.sessionId, usage: turn.usage, warning: turn.warning });
  }));

  if (ctx.dryRun) return null;
  const { audit, missing } = await collect(ctx.root, personas.map((p) => p.name), {
    mode,
    slug: ctx.slug,
    agent: ctx.agent,
  });
  log(`${style.cyan("◆")} audit: ${audit.summary}`);
  if (missing.length) log(`${style.amber("!")} no output from: ${missing.join(", ")}`);
  return audit;
}

/** Gate 5: run the DAG through the selected runtime, streaming state to json/dag-execution.json. */
export async function runExecution(ctx, { log = console.log } = {}) {
  const full = await readJson(artifact(ctx.root, "dag"));
  const plan = ctx.slice ? sliceOnly(full, ctx.slice) : full;
  const runtime = getRuntime(ctx.runtime ?? "local");
  const commandNode = plan.nodes.find((node) => node.command);
  const commandPolicy = commandNode ? policyFor(ctx, "dag-worker", { role: commandNode.role }) : null;
  const exec = createExecution(ctx.root, plan, {
    agent: ctx.agent,
    concurrency: ctx.concurrency ?? 2,
    runtime: runtime.id,
    policy: commandPolicy ? policyEvidence(commandPolicy, null, "command-sandbox") : null,
  });
  const vars = await baseVars(ctx);
  const sliceById = new Map(plan.slices.map((s) => [s.id, s]));

  await exec.event("info", `execution started on ${runtime.label} with ${ctx.agent}`);
  if (ctx.slice) {
    await exec.event("warn", `scoped to slice ${plan.meta.sliceFilter} — ${full.nodes.length - plan.nodes.length} node(s) held back`);
  }
  log(`${style.magenta("▚")} gate 5 execution — runtime ${runtime.id}, concurrency ${ctx.concurrency ?? 2}${ctx.slice ? `, slice ${plan.meta.sliceFilter}` : ""}`);

  const result = await runtime.runGraph({
      plan,
      concurrency: ctx.concurrency ?? 2,
      maxAttempts: ctx.maxAttempts ?? 2,
      hooks: {
      onWave: async (n, total, wave) => {
        await exec.event("info", `wave ${n}/${total}: ${wave.map((w) => w.id).join(", ")}`);
        log(`${style.dim(`  wave ${n}/${total}`)} ${wave.map((w) => `${w.id}:${w.kind}`).join(" ")}`);
      },
      onNodeStart: async (node, attempt) => {
        await exec.update(node.id, { status: "running", attempts: attempt, startedAt: new Date().toISOString() });
        await exec.event("info", `${node.id} ${node.title} (attempt ${attempt})`, node.id);
      },
      onNodeRetry: async (node, attempt, res) => {
        await exec.event("warn", `${node.id} attempt ${attempt} failed: ${res.summary ?? "no summary"}`, node.id);
      },
      onNodeBlocked: async (node, dep) => {
        await exec.update(node.id, { status: "blocked", summary: `blocked by ${dep}` });
        await exec.event("warn", `${node.id} blocked by ${dep}`, node.id);
        log(`${style.amber("  ⊘")} ${node.id} blocked by ${dep}`);
      },
      onNodeEnd: async (node, res) => {
        await exec.update(node.id, {
          status: res.ok ? "passed" : res.blocked ? "blocked" : "failed",
          finishedAt: new Date().toISOString(),
          durationMs: res.durationMs ?? 0,
          exitCode: res.exitCode ?? 0,
          summary: res.summary ?? "",
          logPath: res.logPath ?? "",
          ...(res.policy ? { policy: res.policy } : {}),
        });
        await exec.event(res.ok ? "info" : "error", `${node.id} ${res.ok ? "passed" : "failed"}: ${res.summary ?? ""}`, node.id);
        log(`${res.ok ? style.lime("  ✓") : style.red("  ✗")} ${node.id} ${node.title}${res.ok ? "" : ` — ${res.summary ?? ""}`}`);
      },
      },
      execute: (node) => runNode(ctx, { node, plan, vars, slice: sliceById.get(node.slice), exec }),
  });

  const status = await exec.finish();
  log(`${status === "passed" ? style.lime("▪") : style.red("▪")} execution ${status}`);
  return { status, runtimeStatus: result.status };
}

/**
 * Narrow a plan to one slice so a run can be demoed, or a single slice re-driven, without
 * executing the whole graph. `tracer` selects the plan's tracer slice. Dependencies that point
 * outside the slice are dropped: the nodes they name are not part of this pass, so keeping them
 * would block every node behind them.
 */
export function sliceOnly(plan, wanted) {
  const slice =
    wanted === "tracer"
      ? plan.slices.find((s) => s.tracer)
      : plan.slices.find((s) => s.id === wanted || s.title === wanted);
  if (!slice) {
    const err = new Error(
      `no slice "${wanted}" in the plan — choose one of: ${plan.slices.map((s) => s.id).join(", ")}`,
    );
    err.exitCode = 1;
    throw err;
  }

  const kept = new Set(plan.nodes.filter((n) => n.slice === slice.id).map((n) => n.id));
  return {
    ...plan,
    meta: { ...plan.meta, sliceFilter: slice.id },
    slices: [slice],
    nodes: plan.nodes
      .filter((n) => kept.has(n.id))
      .map((n) => ({ ...n, deps: n.deps.filter((d) => kept.has(d)) })),
  };
}

async function runNode(ctx, { node, vars, slice, exec }) {
  const file = logPath(ctx.root, `node-${node.id}`);
  const started = Date.now();

  if (node.command) {
    const commandPolicy = policyFor(ctx, "dag-worker", { role: node.role });
    let commandSandbox = null;
    let commandSandboxError = null;
    if (!ctx.dryRun) {
      try {
        const factory = ctx.commandSandboxFactory ?? createCommandSandbox;
        commandSandbox = await factory({
          cwd: ctx.cwd,
          allowRead: commandPolicy.readPaths,
          allowWrite: commandPolicy.writePaths,
          denyRead: commandPolicy.protectedPaths,
          denyWrite: commandPolicy.protectedPaths,
          allowedDomains: [],
        });
      } catch (error) {
        commandSandboxError = error;
      }
    }
    try {
      const res = await runCommand(node.command, ctx.cwd, file, ctx.dryRun, { sandbox: commandSandbox, sandboxError: commandSandboxError });
      return {
        ok: res.code === 0,
        exitCode: res.code,
        durationMs: Date.now() - started,
        summary: res.code === 0 ? `${formatCommand(node.command)} ok` : res.stderr || `${formatCommand(node.command)} exited ${res.code}`,
        logPath: relative(ctx.cwd, file),
        blocked: res.blocked,
        policy: policyEvidence(commandPolicy, null, commandSandbox?.backend ?? "anthropic-sandbox-runtime", commandSandboxError),
      };
    } finally {
      await commandSandbox?.close();
    }
  }

  const role = await roleForNode(node.kind);
  const specialist = ctx.specialists === false ? null : await suggestSpecialist(`${node.title} ${node.role.name} ${node.task ?? ""}`);
  const prompt = await renderPrompt("gate5-node.md", {
    ...vars,
    ROLE_PROMPT: node.role.systemPrompt,
    NODE_ID: node.id,
    NODE_TITLE: node.title,
    NODE_KIND: node.kind,
    SLICE_ID: node.slice,
    SLICE_TITLE: slice?.title ?? node.slice,
    SLICE_CRITERIA: (slice?.criteria ?? []).map((c) => `- ${c}`).join("\n") || "- (none recorded)",
    NODE_TASK: node.task ?? node.title,
    WRITE_BOUNDARY: node.role.writeBoundary.map((p) => `- \`${p}\``).join("\n"),
    ASSERTIONS: (node.assertions ?? []).map((a) => `- ${a}`).join("\n") || "- The contract's assertions for this node's layer hold.",
  });

  const before = await changedPaths(ctx.cwd);
  const policy = ctx.workerModel ?? {};
  const workerId = await beginWorker(ctx.root, {
    kind: `dag-${node.kind}`,
    harness: ctx.agent,
    model: policy.model,
    effort: policy.effort,
    task: `${node.id}: ${node.title}`,
  });
  const executionPolicy = policyFor(ctx, "dag-worker", { role: node.role });
  const turn = await invokeFor(ctx)(ctx.agent, {
    prompt,
    role: personaBlock(role, specialist?.body),
    cwd: ctx.cwd,
    workDir: ctx.root,
    logFile: file,
    dryRun: ctx.dryRun,
    timeoutMs: ctx.timeoutMs,
    model: policy.model,
    effort: policy.effort,
    sessionKey: `worker:${workerId}`,
    executionPolicy,
    adapterCapabilities: ctx.adapterCapabilities,
    policyCompiler: ctx.policyCompiler,
    outerSandbox: ctx.outerSandbox,
  });
  await finishWorker(ctx.root, workerId, { ok: turn.code === 0, sessionId: turn.sessionId, usage: turn.usage, warning: turn.warning });
  if (ctx.dryRun) return {
    ok: true,
    exitCode: 0,
    durationMs: 0,
    summary: "dry run",
    logPath: relative(ctx.cwd, file),
    policy: policyEvidence(executionPolicy, turn.nativePolicy?.probe, turn.nativePolicy?.adapter ?? ctx.agent),
  };

  const declaredFail = /^RESULT:\s*fail/im.test(turn.stdout);
  const blocked = /^BLOCKED:/im.test(turn.stdout);
  const after = await changedPaths(ctx.cwd);
  const violations = outOfBounds(before, after, node.role.writeBoundary);

  if (violations.length) {
    await exec.event("error", `${node.id} wrote outside its boundary: ${violations.slice(0, 5).join(", ")}`, node.id);
  }

  const ok = turn.ok && !declaredFail && !blocked && violations.length === 0;
  return {
    ok,
    blocked,
    exitCode: turn.code,
    durationMs: turn.durationMs,
    logPath: relative(ctx.cwd, file),
    summary: violations.length
      ? `write boundary violation: ${violations.slice(0, 3).join(", ")}`
      : blocked
        ? firstLine(turn.stdout, /^BLOCKED:.*/im)
        : declaredFail
          ? firstLine(turn.stdout, /^RESULT:\s*fail.*/im)
          : ok
            ? "passed"
            : `agent exited ${turn.code}`,
    policy: policyEvidence(executionPolicy, turn.nativePolicy?.probe, turn.nativePolicy?.adapter ?? ctx.agent),
  };
}

export async function runCommand(command, cwd, file, dryRun = false, { sandbox, sandboxError } = {}) {
  if (typeof command === "string") {
    return legacyCommandResult();
  }
  if (!isArgvCommand(command)) {
    return invalidCommandResult();
  }
  if (dryRun) return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  if (sandboxError) return { code: 125, stdout: "", stderr: `command sandbox unavailable: ${sandboxError.message}`, blocked: true };
  let ownedSandbox = false;
  let commandRuntime = sandbox;
  if (!commandRuntime) {
    try {
      commandRuntime = await createCommandSandbox({ cwd, allowRead: [cwd], allowWrite: [], allowedDomains: [] });
      ownedSandbox = true;
    } catch (error) {
      const message = error instanceof SandboxUnavailableError ? error.message : `command sandbox unavailable: ${error.message}`;
      return { code: 125, stdout: "", stderr: message, blocked: true };
    }
  }
  const { program, args } = command;
  const log = createWriteStream(file, { flags: "a" });
  log.write(`\n=== ${new Date().toISOString()} argv ${JSON.stringify([program, ...args])}\n`);
  try {
    const result = await commandRuntime.run(command, { cwd, timeout: 30 * 60 * 1000 });
    log.write(result.stdout ?? "");
    log.write(result.stderr ?? "");
    log.end();
    return { code: result.exitCode ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    log.end();
    return { code: 125, stdout: "", stderr: `command sandbox execution failed: ${error.message}`, blocked: true };
  } finally {
    if (ownedSandbox) await commandRuntime.close();
  }
}

function isArgvCommand(command) {
  return Boolean(
    command &&
      typeof command === "object" &&
      !Array.isArray(command) &&
      typeof command.program === "string" &&
      command.program.length > 0 &&
      Array.isArray(command.args) &&
      command.args.every((arg) => typeof arg === "string"),
  );
}

function legacyCommandResult() {
  return {
    code: 125,
    stdout: "",
    stderr: "legacy string command rejected; regenerate Gate 4 plan with command {program,args}",
    blocked: true,
  };
}

function invalidCommandResult() {
  return {
    code: 125,
    stdout: "",
    stderr: "invalid command node; regenerate Gate 4 plan with command {program,args}",
    blocked: true,
  };
}

function formatCommand(command) {
  return typeof command === "string" ? `\`${command}\`` : `\`${JSON.stringify([command.program, ...(command.args ?? [])])}\``;
}

function policyEvidence(policy, probe, backend = "native", error = null) {
  return {
    profile: policy?.profile ?? "unknown",
    version: policy?.version ?? 0,
    backend,
    probe: probe ?? { ok: !error, ...(error ? { reason: error.message } : {}) },
    violations: error ? [error.message] : [],
  };
}

/** Git is the only cheap witness of what a node actually touched. No repo, no enforcement. */
async function changedPaths(cwd) {
  const res = await new Promise((resolvePromise) => {
    const child = spawn("git", ["status", "--porcelain", "-uall"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", () => resolvePromise(null));
    child.on("close", (code) => resolvePromise(code === 0 ? out : null));
  });
  if (res === null) return null;
  return new Set(
    res
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1] : p)),
  );
}

export function outOfBounds(before, after, boundary) {
  if (!before || !after) return [];
  const fresh = [...after].filter((p) => !before.has(p));
  return fresh.filter((path) => !path.startsWith(".astra/") && !boundary.some((rule) => matches(path, rule)));
}

function matches(path, rule) {
  const clean = rule.replace(/^\.\//, "").replace(/\/$/, "");
  if (clean === path) return true;
  if (clean.includes("*")) {
    const pattern = clean
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    return new RegExp(`^${pattern}$`).test(path);
  }
  return path.startsWith(`${clean}/`);
}

function firstLine(text, pattern) {
  return (pattern.exec(text) ?? [])[0]?.trim() ?? "failed";
}
