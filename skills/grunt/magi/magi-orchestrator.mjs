// Pure MAGI tribunal validator, election engine, and report CLI.
//
//   node magi-orchestrator.mjs --tribunal submission.json
//     [--json-out tribunal.json] [--out tribunal-report.md]
//   node magi-orchestrator.mjs --selftest
//
// Live core spawning and bd-mail collection belong to Sideeye's host skill contract.

import Ajv from "ajv";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, "schemas");

export const CORE_ORDER = Object.freeze(["Melchior-1", "Balthasar-2", "Casper-3"]);
export const CANDIDATE_ORDER = Object.freeze([
  "melchior-plan",
  "balthasar-plan",
  "casper-plan",
]);
export const MATCHUPS = Object.freeze([
  Object.freeze({
    matchup_id: "melchior-v-balthasar",
    candidate_plan_ids: Object.freeze(["melchior-plan", "balthasar-plan"]),
  }),
  Object.freeze({
    matchup_id: "melchior-v-casper",
    candidate_plan_ids: Object.freeze(["melchior-plan", "casper-plan"]),
  }),
  Object.freeze({
    matchup_id: "balthasar-v-casper",
    candidate_plan_ids: Object.freeze(["balthasar-plan", "casper-plan"]),
  }),
]);

const CANDIDATE_AUTHORS = Object.freeze({
  "melchior-plan": "Melchior-1",
  "balthasar-plan": "Balthasar-2",
  "casper-plan": "Casper-3",
});
const cores = JSON.parse(readFileSync(join(HERE, "cores.json"), "utf8")).cores;

function readSchema(name) {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));
}

const candidateSchema = readSchema("candidate-plan.schema.json");
const deliberationSchema = readSchema("comparative-deliberation.schema.json");
const ballotSchema = readSchema("pairwise-ballot.schema.json");
const submissionSchema = readSchema("tribunal-submission.schema.json");
const tribunalSchema = readSchema("tribunal.schema.json");
const ajv = new Ajv({ allErrors: true, strict: false });
for (const schema of [candidateSchema, deliberationSchema, ballotSchema, submissionSchema]) {
  ajv.addSchema(schema);
}
const validateSubmissionSchema = ajv.getSchema(submissionSchema.$id);
const validateTribunalSchema = ajv.compile(tribunalSchema);

function schemaErrors(label, errors) {
  return (errors ?? [])
    .map((error) => label + (error.instancePath || "/") + " " + error.message)
    .join("; ");
}

function sameOrder(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function exactSet(items, property, expected, label) {
  const values = items.map((item) => item[property]);
  const unique = new Set(values);
  if (unique.size !== values.length) {
    throw new Error(label + " contains a duplicate or replayed " + property);
  }
  const missing = expected.filter((value) => !unique.has(value));
  const unknown = [...unique].filter((value) => !expected.includes(value));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      label + " requires exact set; missing: " + (missing.join(", ") || "none") +
      "; unknown: " + (unknown.join(", ") || "none"),
    );
  }
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function seedCommitment(tribunalId, seed) {
  return sha256(tribunalId + "\0" + seed);
}

function validateCandidatePlans(submission) {
  const plans = submission.candidate_plans;
  exactSet(plans, "candidate_plan_id", CANDIDATE_ORDER, "candidate plans");
  exactSet(plans, "author_core", CORE_ORDER, "candidate plans");
  for (const plan of plans) {
    if (plan.tribunal_id !== submission.tribunal_id) {
      throw new Error("candidate plan tribunal_id mismatch");
    }
    if (CANDIDATE_AUTHORS[plan.candidate_plan_id] !== plan.author_core) {
      throw new Error("candidate plan author does not match its fixed candidate identity");
    }
  }
  const distinctProposals = new Set(plans.map((plan) => canonical(plan.proposal)));
  if (distinctProposals.size !== CANDIDATE_ORDER.length) {
    throw new Error("all three cores must author distinct candidate proposals");
  }
  return CANDIDATE_ORDER.map((id) => plans.find((plan) => plan.candidate_plan_id === id));
}

function validateDeliberations(submission) {
  const deliberations = submission.comparative_deliberations;
  exactSet(deliberations, "core_name", CORE_ORDER, "comparative deliberations");
  for (const deliberation of deliberations) {
    if (deliberation.tribunal_id !== submission.tribunal_id) {
      throw new Error("comparative deliberation tribunal_id mismatch");
    }
    exactSet(deliberation.assessments, "candidate_plan_id", CANDIDATE_ORDER, "deliberation assessments");
  }
  return CORE_ORDER.map((name) => deliberations.find((item) => item.core_name === name));
}

function validateBallots(submission) {
  const ballots = submission.sealed_pairwise_ballots;
  const ballotIds = ballots.map((ballot) => ballot.ballot_id);
  if (new Set(ballotIds).size !== ballotIds.length) {
    throw new Error("sealed ballots contain a duplicate or replayed ballot_id");
  }
  for (const ballot of ballots) {
    if (ballot.tribunal_id !== submission.tribunal_id) {
      throw new Error("sealed ballot tribunal_id mismatch or cross-tribunal replay");
    }
  }

  return MATCHUPS.map((matchup) => {
    const matchupBallots = ballots.filter((ballot) => ballot.matchup_id === matchup.matchup_id);
    if (matchupBallots.length !== CORE_ORDER.length) {
      throw new Error(matchup.matchup_id + " requires exactly three sealed ballots");
    }
    exactSet(matchupBallots, "core_name", CORE_ORDER, matchup.matchup_id + " ballots");
    for (const ballot of matchupBallots) {
      if (!sameOrder(ballot.candidate_plan_ids, matchup.candidate_plan_ids)) {
        throw new Error(matchup.matchup_id + " ballot has the wrong fixed candidate pair");
      }
      if (!matchup.candidate_plan_ids.includes(ballot.selected_plan_id)) {
        throw new Error(matchup.matchup_id + " ballot selected a candidate outside the matchup");
      }
    }
    return CORE_ORDER.map((name) => matchupBallots.find((ballot) => ballot.core_name === name));
  });
}

export function validateTribunalSubmission(submission) {
  if (!validateSubmissionSchema(submission)) {
    throw new Error(schemaErrors("tribunal", validateSubmissionSchema.errors));
  }
  const expectedCommitment = seedCommitment(submission.tribunal_id, submission.tie_break.seed);
  if (submission.tie_break.commitment_sha256 !== expectedCommitment) {
    throw new Error("tie-break seed commitment does not match tribunal_id and seed");
  }

  // Candidate content is not returned until the complete exact set validates.
  const candidatePlans = validateCandidatePlans(submission);
  const deliberations = validateDeliberations(submission);
  // Each matchup remains sealed until its complete exact core set validates.
  const matchupBallots = validateBallots(submission);
  return { candidatePlans, deliberations, matchupBallots };
}

function resolveMatchup(matchup, ballots) {
  const voteTotals = Object.fromEntries(CANDIDATE_ORDER.map((id) => [id, 0]));
  for (const ballot of ballots) voteTotals[ballot.selected_plan_id] += 1;
  const [first, second] = matchup.candidate_plan_ids;
  const winnerPlanId = voteTotals[first] > voteTotals[second] ? first : second;
  const loserPlanId = winnerPlanId === first ? second : first;
  return {
    matchup_id: matchup.matchup_id,
    candidate_plan_ids: [...matchup.candidate_plan_ids],
    vote_totals: voteTotals,
    winner_plan_id: winnerPlanId,
    loser_plan_id: loserPlanId,
    margin: voteTotals[winnerPlanId] - voteTotals[loserPlanId],
  };
}

function candidateStats(matchupResults) {
  const stats = Object.fromEntries(CANDIDATE_ORDER.map((id) => [id, {
    matchup_wins: 0,
    ballots_for: 0,
    ballots_against: 0,
    aggregate_margin: 0,
  }]));
  for (const result of matchupResults) {
    stats[result.winner_plan_id].matchup_wins += 1;
    for (const candidateId of result.candidate_plan_ids) {
      const opponentId = result.candidate_plan_ids.find((id) => id !== candidateId);
      stats[candidateId].ballots_for += result.vote_totals[candidateId];
      stats[candidateId].ballots_against += result.vote_totals[opponentId];
    }
  }
  for (const value of Object.values(stats)) {
    value.aggregate_margin = value.ballots_for - value.ballots_against;
  }
  return stats;
}

function seededOrder(candidateIds, seed) {
  return [...candidateIds].sort((left, right) => {
    const hashOrder = sha256(seed + "\0" + left).localeCompare(sha256(seed + "\0" + right));
    return hashOrder || left.localeCompare(right);
  });
}

export function resolveTribunal(submission) {
  const { candidatePlans, deliberations, matchupBallots } = validateTribunalSubmission(submission);
  const matchupResults = MATCHUPS.map((matchup, index) => resolveMatchup(matchup, matchupBallots[index]));
  const stats = candidateStats(matchupResults);
  const condorcetWinner = CANDIDATE_ORDER.find((id) => stats[id].matchup_wins === 2);

  let method;
  let selectedPlanId;
  let rationale;
  if (condorcetWinner) {
    method = "condorcet";
    selectedPlanId = condorcetWinner;
    rationale = selectedPlanId + " defeated both alternatives head-to-head.";
  } else {
    const maximumMargin = Math.max(...CANDIDATE_ORDER.map((id) => stats[id].aggregate_margin));
    const marginLeaders = CANDIDATE_ORDER.filter((id) => stats[id].aggregate_margin === maximumMargin);
    if (marginLeaders.length === 1) {
      method = "aggregate-margin-cycle-break";
      selectedPlanId = marginLeaders[0];
      rationale = "A Condorcet cycle occurred; " + selectedPlanId + " had the highest aggregate vote margin (" + maximumMargin + ").";
    } else {
      method = "seeded-cycle-break";
      selectedPlanId = seededOrder(marginLeaders, submission.tie_break.seed)[0];
      rationale = "A Condorcet cycle remained tied on aggregate vote margin; the precommitted seed selected " + selectedPlanId + ".";
    }
  }

  const dissent = deliberations
    .filter((item) => item.preferred_plan_id !== selectedPlanId)
    .map((item) => ({
      core_name: item.core_name,
      preferred_plan_id: item.preferred_plan_id,
      rationale: item.rationale,
    }));
  const tribunal = {
    ...submission,
    candidate_plans: candidatePlans,
    comparative_deliberations: deliberations,
    sealed_pairwise_ballots: MATCHUPS.flatMap((_, index) => matchupBallots[index]),
    result: {
      method,
      matchup_results: matchupResults,
      selected_plan_id: selectedPlanId,
      support: stats[selectedPlanId],
      rationale,
      dissent,
    },
  };
  if (!validateTribunalSchema(tribunal)) {
    throw new Error(schemaErrors("resolved tribunal", validateTribunalSchema.errors));
  }
  return tribunal;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderReport(tribunal) {
  const planById = new Map(tribunal.candidate_plans.map((plan) => [plan.candidate_plan_id, plan]));
  const candidateRows = tribunal.candidate_plans.map((plan) =>
    "| " + plan.candidate_plan_id + " | " + plan.author_core + " | " + escapeCell(plan.title) + " |",
  );
  const matchupRows = tribunal.result.matchup_results.map((result) => {
    const [left, right] = result.candidate_plan_ids;
    return "| " + result.matchup_id + " | " + result.vote_totals[left] + "–" + result.vote_totals[right] + " | " + result.winner_plan_id + " | " + result.margin + " |";
  });
  const dissentRows = tribunal.result.dissent.length === 0
    ? ["| none | — | — |"]
    : tribunal.result.dissent.map((item) =>
      "| " + item.core_name + " | " + item.preferred_plan_id + " | " + escapeCell(item.rationale) + " |",
    );
  const selected = planById.get(tribunal.result.selected_plan_id);
  return [
    "# MAGI Tribunal — " + tribunal.tribunal_id,
    "",
    "## Candidate plans",
    "",
    "| Candidate | Author | Title |",
    "|---|---|---|",
    ...candidateRows,
    "",
    "## Pairwise matchups",
    "",
    "| Matchup | Votes | Winner | Margin |",
    "|---|---:|---|---:|",
    ...matchupRows,
    "",
    "## Decision",
    "",
    "**Selected:** " + tribunal.result.selected_plan_id + " — " + selected.title,
    "**Method:** " + tribunal.result.method,
    "**Support:** " + tribunal.result.support.matchup_wins + " matchup wins; aggregate margin " + tribunal.result.support.aggregate_margin,
    "**Rationale:** " + tribunal.result.rationale,
    "",
    "## Named dissent",
    "",
    "| Core | Preferred plan | Rationale |",
    "|---|---|---|",
    ...dissentRows,
    "",
    "## Effective hyperparameter behavior",
    "",
    "Advisory. This validator/election CLI does not spawn models or set sampling parameters. A live host must record whether it honored each core's requested settings; otherwise the personas carry the behavioral distinction.",
    "",
  ].join("\n");
}

function selftestSubmission(winners, unanimous = new Set()) {
  const tribunalId = "magi-selftest";
  const candidatePlans = CANDIDATE_ORDER.map((candidateId, index) => ({
    tribunal_id: tribunalId,
    candidate_plan_id: candidateId,
    author_core: CORE_ORDER[index],
    authored_in_isolation: true,
    title: CORE_ORDER[index] + " candidate",
    proposal: {
      objective: "Objective " + index,
      steps: ["Step " + index],
      success_criteria: ["Criterion " + index],
      risks: ["Risk " + index],
    },
  }));
  const comparativeDeliberations = CORE_ORDER.map((coreName, index) => ({
    tribunal_id: tribunalId,
    core_name: coreName,
    assessments: CANDIDATE_ORDER.map((candidateId) => ({
      candidate_plan_id: candidateId,
      strengths: "Strengths for " + candidateId,
      risks: "Risks for " + candidateId,
    })),
    preferred_plan_id: CANDIDATE_ORDER[index],
    rationale: coreName + " preference.",
  }));
  const sealedPairwiseBallots = MATCHUPS.flatMap((matchup) => {
    const winner = winners[matchup.matchup_id];
    const loser = matchup.candidate_plan_ids.find((id) => id !== winner);
    return CORE_ORDER.map((coreName, index) => ({
      tribunal_id: tribunalId,
      ballot_id: tribunalId + ":" + matchup.matchup_id + ":" + coreName.toLowerCase(),
      core_name: coreName,
      matchup_id: matchup.matchup_id,
      candidate_plan_ids: [...matchup.candidate_plan_ids],
      selected_plan_id: unanimous.has(matchup.matchup_id) || index < 2 ? winner : loser,
      rationale: coreName + " pairwise choice.",
      sealed: true,
    }));
  });
  const seed = "stable-selftest-seed";
  return {
    schema_version: "1.0.0",
    tribunal_id: tribunalId,
    tie_break: { algorithm: "sha256", seed, commitment_sha256: seedCommitment(tribunalId, seed) },
    candidate_plans: candidatePlans,
    comparative_deliberations: comparativeDeliberations,
    sealed_pairwise_ballots: sealedPairwiseBallots,
  };
}

function selftest() {
  const condorcet = resolveTribunal(selftestSubmission({
    "melchior-v-balthasar": "melchior-plan",
    "melchior-v-casper": "melchior-plan",
    "balthasar-v-casper": "balthasar-plan",
  }, new Set(["melchior-v-casper"])));
  if (condorcet.result.method !== "condorcet" || condorcet.result.selected_plan_id !== "melchior-plan") {
    throw new Error("Condorcet self-test failed");
  }
  const marginCycle = resolveTribunal(selftestSubmission({
    "melchior-v-balthasar": "melchior-plan",
    "melchior-v-casper": "casper-plan",
    "balthasar-v-casper": "balthasar-plan",
  }, new Set(["melchior-v-balthasar"])));
  if (marginCycle.result.method !== "aggregate-margin-cycle-break") {
    throw new Error("aggregate-margin cycle self-test failed");
  }
  const seededCycle = resolveTribunal(selftestSubmission({
    "melchior-v-balthasar": "melchior-plan",
    "melchior-v-casper": "casper-plan",
    "balthasar-v-casper": "balthasar-plan",
  }));
  if (seededCycle.result.method !== "seeded-cycle-break") {
    throw new Error("seeded cycle self-test failed");
  }
  console.log("resolved: 3/3 elections  candidates: 3  matchups: 3  sealed ballots: 9  deadlocks: 0");
  console.log("cores: " + cores.map((core) => core.core_name).join(", "));
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(name + " requires a value");
  return value;
}

function main(args) {
  if (args.includes("--selftest")) {
    selftest();
    return;
  }
  const tribunalPath = optionValue(args, "--tribunal");
  if (!tribunalPath) {
    throw new Error("usage: magi-orchestrator.mjs --tribunal submission.json [--json-out tribunal.json] [--out tribunal-report.md]");
  }
  const submission = JSON.parse(readFileSync(tribunalPath, "utf8"));
  const tribunal = resolveTribunal(submission);
  const jsonOutputPath = optionValue(args, "--json-out");
  const reportOutputPath = optionValue(args, "--out");
  if (jsonOutputPath) writeFileSync(jsonOutputPath, JSON.stringify(tribunal, null, 2) + "\n", "utf8");
  if (reportOutputPath) writeFileSync(reportOutputPath, renderReport(tribunal), "utf8");
  console.log("selected: " + tribunal.result.selected_plan_id);
  console.log("method: " + tribunal.result.method);
  console.log("support: " + tribunal.result.support.matchup_wins + " matchup wins; aggregate margin " + tribunal.result.support.aggregate_margin);
  console.log("dissent: " + (tribunal.result.dissent.map((item) => item.core_name).join(", ") || "none"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error("MAGI validation failed: " + error.message);
    process.exitCode = 1;
  }
}
