import { artifact } from "./paths.mjs";
import { GATES, GATE_IDS, getGate, nextGate } from "./gates.mjs";
import { nowIso, readJson, writeJson, writeText, exists } from "./util.mjs";

export const LOOP_BUDGET = 2;

export function emptyLedger({ slug, intent, agent, judge, runRoot, cwd }) {
  return {
    meta: {
      slug,
      intent,
      agent,
      judge,
      runRoot,
      cwd,
      schemaVersion: "1.0",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    phase: GATE_IDS[0],
    complete: false,
    gates: Object.fromEntries(
      GATE_IDS.map((id) => [id, { status: "pending", ranAt: null, clearedAt: null, loops: 0 }]),
    ),
    history: [],
  };
}

export async function loadLedger(root) {
  const path = artifact(root, "ledger");
  if (!(await exists(path))) return null;
  return readJson(path);
}

export async function saveLedger(root, ledger) {
  ledger.meta.updatedAt = nowIso();
  await writeJson(artifact(root, "ledger"), ledger);
  await writeText(artifact(root, "status"), renderStatus(ledger));
  return ledger;
}

export function record(ledger, event) {
  ledger.history.push({ ts: nowIso(), ...event });
  return ledger;
}

export function markRan(ledger, gateId, detail) {
  const gate = ledger.gates[gateId];
  gate.status = "ran";
  gate.ranAt = nowIso();
  return record(ledger, { gate: gateId, action: "ran", detail });
}

export function markFailed(ledger, gateId, detail) {
  ledger.gates[gateId].status = "failed";
  return record(ledger, { gate: gateId, action: "failed", detail });
}

export function markCleared(ledger, gateId, by = "human") {
  const gate = ledger.gates[gateId];
  gate.status = "cleared";
  gate.clearedAt = nowIso();
  return record(ledger, { gate: gateId, action: "cleared", by });
}

/** Advance to the next phase. Refuses while the current gate is unclear. */
export function advance(ledger) {
  const current = getGate(ledger.phase);
  if (ledger.gates[current.id].status !== "cleared") {
    const err = new Error(`gate "${current.id}" is not cleared — run \`astra gate ${current.id}\` then have a human approve it`);
    err.exitCode = 3;
    throw err;
  }
  const next = nextGate(current.id);
  if (!next) {
    ledger.complete = true;
    record(ledger, { gate: current.id, action: "complete" });
    return ledger;
  }
  ledger.phase = next.id;
  record(ledger, { gate: next.id, action: "entered" });
  return ledger;
}

/** Loop back to an earlier gate. Each gate carries its own loop budget. */
export function loop(ledger, toGateId, reason) {
  const target = getGate(toGateId);
  const from = GATE_IDS.indexOf(ledger.phase);
  const to = GATE_IDS.indexOf(target.id);
  if (to > from) {
    const err = new Error(`cannot loop forward — "${target.id}" is ahead of "${ledger.phase}"; use \`astra advance\``);
    err.exitCode = 3;
    throw err;
  }
  const gate = ledger.gates[target.id];
  if (gate.loops >= LOOP_BUDGET) {
    const err = new Error(`loop budget exhausted for "${target.id}" (${LOOP_BUDGET}) — escalate to the human instead of looping again`);
    err.exitCode = 2;
    throw err;
  }
  gate.loops += 1;
  for (const id of GATE_IDS.slice(to)) {
    ledger.gates[id].status = "pending";
    ledger.gates[id].clearedAt = null;
  }
  ledger.phase = target.id;
  ledger.complete = false;
  return record(ledger, { gate: target.id, action: "loop", reason });
}

const CHIP = { pending: "[ ]", ran: "[~]", cleared: "[x]", failed: "[!]" };

export function renderStatus(ledger) {
  const lines = [
    "# Astra OS — run status",
    "",
    `- **intent**: ${ledger.meta.intent}`,
    `- **slug**: \`${ledger.meta.slug}\``,
    `- **agent**: \`${ledger.meta.agent}\` (drives every gate)`,
    `- **judge**: \`${ledger.meta.judge}\``,
    `- **phase**: \`${ledger.phase}\`${ledger.complete ? " (complete)" : ""}`,
    `- **updated**: ${ledger.meta.updatedAt}`,
    "",
    "| # | Gate | Status | Ran | Cleared | Loops |",
    "|---|---|---|---|---|---|",
  ];

  for (const gate of GATES) {
    const state = ledger.gates[gate.id];
    lines.push(
      `| ${gate.n} | ${gate.name} | ${CHIP[state.status] ?? state.status} ${state.status} | ${short(state.ranAt)} | ${short(state.clearedAt)} | ${state.loops} |`,
    );
  }

  if (ledger.history.length) {
    lines.push("", "## History", "");
    for (const entry of ledger.history.slice(-40)) {
      const detail = entry.detail ?? entry.reason ?? entry.by ?? "";
      lines.push(`- \`${entry.ts}\` **${entry.gate}** ${entry.action}${detail ? ` — ${detail}` : ""}`);
    }
  }

  return lines.join("\n");
}

function short(iso) {
  return iso ? iso.replace("T", " ").slice(0, 19) : "—";
}
