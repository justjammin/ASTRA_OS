import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  deriveScoutPolicy,
  deriveCoordinatorPolicy,
  deriveJudgePolicy,
  deriveDagWorkerPolicy,
  isPathAllowed,
} from "../lib/execution-policy.mjs";

const cwd = "/workspace/project";

test("scout policy is read-only and denies risky capabilities", () => {
  const policy = deriveScoutPolicy({ cwd });

  assert.equal(policy.profile, "scout");
  assert.deepEqual(policy.readPaths, [cwd]);
  assert.deepEqual(policy.writePaths, []);
  assert.deepEqual(policy.capabilities, { shell: false, network: false, delegation: false });
  assert.equal(JSON.parse(JSON.stringify(policy)).profile, "scout");
});

test("coordinator policy canonicalizes declared gate artifacts", () => {
  const policy = deriveCoordinatorPolicy({
    cwd,
    artifactPaths: [".astra/demo/../demo/00-status.md", join(cwd, ".astra/demo/PLAN.md"), ".astra/demo/PLAN.md"],
  });

  assert.equal(policy.profile, "coordinator");
  assert.deepEqual(policy.writePaths, [
    join(cwd, ".astra/demo/00-status.md"),
    join(cwd, ".astra/demo/PLAN.md"),
  ]);
  assert.deepEqual(policy.readPaths, [cwd]);
});

test("judge policy permits exactly one canonical audit output", () => {
  const policy = deriveJudgePolicy({ cwd, auditPath: ".astra/demo/json/audit-caspar.json" });

  assert.equal(policy.profile, "judge");
  assert.deepEqual(policy.writePaths, [join(cwd, ".astra/demo/json/audit-caspar.json")]);
  assert.deepEqual(policy.readPaths, [cwd]);
});

test("DAG worker policy derives writes from role.writeBoundary", () => {
  const policy = deriveDagWorkerPolicy({ cwd, role: { writeBoundary: ["src/../src/widget.mjs", "test/widget.test.mjs"] } });

  assert.equal(policy.profile, "dag-worker");
  assert.deepEqual(policy.writePaths, [join(cwd, "src/widget.mjs"), join(cwd, "test/widget.test.mjs")]);
  assert.deepEqual(policy.readPaths, [cwd]);
});

test("policy rejects escapes and hard-protected repository paths", () => {
  assert.throws(() => deriveCoordinatorPolicy({ cwd, artifactPaths: ["../outside.txt"] }), /outside policy root/);
  assert.throws(() => deriveCoordinatorPolicy({ cwd, artifactPaths: [".git/config"] }), /protected/);
  assert.throws(() => deriveDagWorkerPolicy({ cwd, role: { writeBoundary: [".env"] } }), /protected/);
  assert.throws(() => deriveDagWorkerPolicy({ cwd, role: { writeBoundary: [".claude/settings.json"] } }), /protected/);

  const policy = deriveScoutPolicy({ cwd });
  assert.equal(isPathAllowed(policy, join(cwd, ".git/config"), "read"), false);
  assert.equal(isPathAllowed(policy, join(cwd, "src/widget.mjs"), "read"), true);
  assert.equal(isPathAllowed(policy, join(cwd, "src/widget.mjs"), "write"), false);
});

test("policy derivation rejects missing or malformed path declarations", () => {
  assert.throws(() => deriveJudgePolicy({ cwd }), /auditPath/);
  assert.throws(() => deriveJudgePolicy({ cwd, auditPath: ["a.json", "b.json"] }), /auditPath/);
  assert.throws(() => deriveDagWorkerPolicy({ cwd, role: {} }), /writeBoundary/);
  assert.throws(() => deriveCoordinatorPolicy({ cwd, artifactPaths: ["  "] }), /path/);
});
