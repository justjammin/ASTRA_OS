import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("release workflows normalize version inputs before checking out an exact tag", async () => {
  const root = await mkdtemp(join(tmpdir(), "astra-release-tag-"));
  const output = join(root, "output");
  try {
    for (const name of ["release.yml", "npm-publish.yml"]) {
      const workflow = await readFile(join(ROOT, ".github/workflows", name), "utf8");
      const script = workflow.match(/- name: Normalize release tag[\s\S]*?run: \|\n([\s\S]*?)\n      - name:/)?.[1];
      assert.ok(script, `${name} must normalize before checkout`);
      assert.match(workflow, /ref: refs\/tags\/\$\{\{ steps\.release-tag\.outputs\.tag \}\}/);
      for (const input of ["0.2.5", "v0.2.5", "0.2.5-rc.1"]) {
        await writeFile(output, "");
        execFileSync("bash", ["-e", "-c", script], { env: { ...process.env, REQUESTED_TAG: input, GITHUB_OUTPUT: output } });
        assert.equal(await readFile(output, "utf8"), `tag=v${input.replace(/^v/, "")}\n`);
      }
      for (const input of ["", "main", "refs/heads/main", "$(exit 0)", "0.2.5\ntag=main"]) {
        assert.throws(() => execFileSync("bash", ["-e", "-c", script], {
          env: { ...process.env, REQUESTED_TAG: input, GITHUB_OUTPUT: output }, stdio: "pipe",
        }));
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package and lockfile versions stay synchronized", async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(join(ROOT, "package-lock.json"), "utf8"));
  assert.equal(lockfile.version, packageJson.version);
  assert.equal(lockfile.packages[""].version, packageJson.version);
  assert.equal(packageJson.repository?.url, "https://github.com/justjammin/ASTRA_OS");
});

test("release workflow is tag-gated and publishes the packed artifact", async () => {
  const workflow = await readFile(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /v\*\.\*\.\*/);
  assert.doesNotMatch(workflow, /npm publish/);
  assert.match(workflow, /gh release create[\s\S]*\$PACKAGE_TGZ/);
  assert.match(workflow, /RELEASE_TAG[\s\S]*package\.json/);
  assert.match(workflow, /bubblewrap socat ripgrep/);
});

test("npm workflow is tag-gated and publishes with trusted provenance", async () => {
  const workflow = await readFile(join(ROOT, ".github", "workflows", "npm-publish.yml"), "utf8");
  assert.match(workflow, /v\*\.\*\.\*/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /environment:\s*\n\s*name:\s*npm-release/);
  assert.match(workflow, /RELEASE_TAG[\s\S]*package\.json/);
  assert.match(workflow, /npm publish --access public --provenance/);
  assert.match(workflow, /bubblewrap socat ripgrep/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
});
