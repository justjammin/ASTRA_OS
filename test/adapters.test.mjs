import { test } from "node:test";
import assert from "node:assert/strict";

import { ADAPTER_IDS, getAdapter, invoke } from "../lib/adapters.mjs";

test("Pi is a native SDK adapter", async () => {
  assert.ok(ADAPTER_IDS.includes("pi"));
  assert.equal(getAdapter("pi").sdk, true);

  const result = await invoke("pi", {
    prompt: "test",
    role: "worker",
    cwd: process.cwd(),
    workDir: process.cwd(),
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.argv, ["pi", "(native SDK)"]);
});
