import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkGate, GATES } from "../lib/gates.mjs";
import { runDesignGate } from "../lib/pipeline.mjs";
import { loadSchema } from "../lib/prompt.mjs";
import { validate } from "../lib/validate.mjs";
import { materializeUserStory, OPEN_PENCIL_CLI_WRAPPER, renderUserStoryHtml } from "../lib/user-story-materializer.mjs";
import { inspectMermaid, validateUserStory } from "../lib/user-story.mjs";

const UI_STORY = {
  meta: { slug: "demo", intent: "Review a result", surface: "ui" },
  mermaid: "flowchart TD\n  start[User opens the product] --> result[User sees the result]",
  screens: [{
    id: "u1",
    name: "Result",
    purpose: "Review the result",
    elements: [
      { type: "heading", label: "Result" },
      { type: "button", label: "Continue" },
    ],
    acceptance: ["The user can continue."],
  }],
};

const NON_UI_STORY = {
  meta: { slug: "demo", intent: "Run a report", surface: "non-ui" },
  mermaid: "flowchart TD\n  start[User runs the report] --> done[Report is written]",
};

const VALID_FIG = Buffer.from("504b0506000000000000000000000000000000000000", "hex");
const VALID_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function rootFixture(slug = "demo") {
  const root = await mkdtemp(join(tmpdir(), "astra-user-story-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "json"), { recursive: true });
  return { root, slug };
}

test("Gate 1 uses the user-story artifact and schema", async () => {
  assert.deepEqual(GATES[0].artifacts.map((spec) => spec.key), ["product", "userStory"]);
  const schema = await loadSchema("user-story");
  assert.equal(validate(schema, UI_STORY).ok, true);
  assert.equal(validate(schema, NON_UI_STORY).ok, true);
  assert.equal(validateUserStory(UI_STORY).ok, true);
  assert.equal(validateUserStory(NON_UI_STORY).ok, true);
});

test("user-story validation rejects malformed Mermaid and UI/non-UI mismatches", () => {
  assert.equal(inspectMermaid("flowchart TD\n  start[Open").ok, false);
  assert.equal(inspectMermaid("flowchart TD\n  start[Open] --> done[Done]").ok, true);
  for (const unsafe of [
    "flowchart TD\n  a[<div>Open</div>] --> b[Done]",
    "flowchart TD\n  a[Open] --> b[Done <!-- comment -->]",
    "flowchart TD\n  a[data:text/html,pwned] --> b[Done]",
    "flowchart TD\n  a[Open] --> b[//example.com/result]",
    "flowchart TD\n  a[Open] --> b[www.example.com]",
    "flowchart TD\n  a[Open] --> b[example.com/result]",
  ]) assert.equal(inspectMermaid(unsafe).ok, false, unsafe);
  assert.match(validateUserStory({ ...NON_UI_STORY, screens: [] }).detail, /omit screens/);
  assert.match(validateUserStory({ ...UI_STORY, screens: [] }).detail, /require at least one screen/);
  assert.match(validateUserStory(UI_STORY, { slug: "other-run" }).detail, /match active run slug/);
});

test("OpenPencil materializer uses fixed argv, escapes labels, and writes fig plus PNG", async () => {
  const { root } = await rootFixture();
  const calls = [];
  const png = VALID_PNG;
  const result = await materializeUserStory(root, {
    ...UI_STORY,
    screens: [{ ...UI_STORY.screens[0], elements: [{ type: "text", label: "<img src=x onerror=alert(1)>" }] }],
  }, {
    execFile(program, args, options, callback) {
      calls.push({ program, args, options });
      const output = args[args.indexOf("--output") + 1];
      const isImport = args[1] === "import";
      writeFile(output, isImport ? VALID_FIG : png).then(() => callback(null, "", ""), callback);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].program, process.execPath);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].args[0], OPEN_PENCIL_CLI_WRAPPER);
  assert.deepEqual(calls[0].args.slice(1, 4), ["import", calls[0].args[2], "--format"]);
  assert.equal(calls[0].args[calls[0].args.indexOf("--css") + 1].endsWith("user-story.css"), true);
  assert.deepEqual(calls[1].args.slice(0, 5), [OPEN_PENCIL_CLI_WRAPPER, "export", join(root, "designs/user-story.fig"), "--format", "png"]);
  const html = renderUserStoryHtml({
    ...UI_STORY,
    screens: [{ ...UI_STORY.screens[0], elements: [{ type: "text", label: "<img src=x>" }] }],
  });
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.deepEqual(await readFile(join(root, "designs/user-story.fig")), VALID_FIG);
  assert.deepEqual(await readFile(join(root, "assets/user-story.png")), png);
});

test("non-UI materialization removes stale OpenPencil outputs", async () => {
  const { root } = await rootFixture();
  await materializeUserStory(root, UI_STORY, {
    execFile(program, args, options, callback) {
      const output = args[args.indexOf("--output") + 1];
      writeFile(output, args[1] === "import" ? VALID_FIG : VALID_PNG).then(() => callback(null), callback);
    },
  });
  const result = await materializeUserStory(root, NON_UI_STORY);
  assert.deepEqual(result.outputs, []);
  await assert.rejects(access(join(root, "designs/user-story.fig")));
  await assert.rejects(access(join(root, "assets/user-story.png")));
});

test("materializer failure is a harness failure and does not trigger agent repair", async () => {
  const { root } = await rootFixture();
  await writeFile(join(root, "docs/01-product.md"), "x".repeat(500));
  await writeFile(join(root, "json/user-story.json"), JSON.stringify(UI_STORY));
  const calls = [];
  const result = await runDesignGate({
    root,
    cwd: root,
    slug: "demo",
    intent: "Review a result",
    agent: "claude",
    judge: "solo",
    workerModel: {},
    invoke: async (_agent, options) => {
      calls.push(options.prompt);
      return { ok: true, code: 0, stdout: "", usage: {} };
    },
    userStoryMaterializer: async () => { throw new Error("OpenPencil unavailable"); },
  }, "product", { log: () => {} });

  assert.equal(result.ok, false);
  assert.equal(result.harnessFailure, true);
  assert.match(result.detail, /materialization failed.*OpenPencil unavailable/);
  assert.equal(calls.length, 2, "scout and coordinator only; no repair for host materializer failure");
});

test("checkGate validates the Mermaid user story contract", async () => {
  const { root } = await rootFixture();
  await writeFile(join(root, "docs/01-product.md"), "x".repeat(500));
  await writeFile(join(root, "json/user-story.json"), JSON.stringify(NON_UI_STORY));
  const valid = await checkGate(root, "product");
  assert.equal(valid.ok, true);

  await writeFile(join(root, "json/user-story.json"), JSON.stringify({ ...NON_UI_STORY, mermaid: "not a diagram" }));
  const invalid = await checkGate(root, "product");
  assert.equal(invalid.ok, false);
  assert.match(invalid.checks.at(-1).detail, /shorter than minLength|Mermaid/);
});

test("active run slug and UI materialization are approval-bound contracts", async () => {
  const { root } = await rootFixture();
  await writeFile(join(root, "docs/01-product.md"), "x".repeat(500));
  await writeFile(join(root, "status.json"), JSON.stringify({ meta: { slug: "active-run" } }));
  await writeFile(join(root, "json/user-story.json"), JSON.stringify(UI_STORY));

  const mismatched = await checkGate(root, "product");
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.checks.at(-1).detail, /match active run slug/);

  await writeFile(join(root, "json/user-story.json"), JSON.stringify({ ...UI_STORY, meta: { ...UI_STORY.meta, slug: "active-run" } }));
  const missing = await checkGate(root, "product", { requireMaterialization: true });
  assert.equal(missing.ok, false);
  assert.match(missing.checks.at(-1).detail, /structurally valid PNG/);

  await mkdir(join(root, "designs"), { recursive: true });
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "designs/user-story.fig"), VALID_FIG);
  await writeFile(join(root, "assets/user-story.png"), VALID_PNG);
  const ready = await checkGate(root, "product", { requireMaterialization: true });
  assert.equal(ready.ok, true);
});
