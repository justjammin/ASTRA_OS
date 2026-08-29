import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package and lockfile versions stay synchronized", async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(join(ROOT, "package-lock.json"), "utf8"));
  assert.equal(lockfile.version, packageJson.version);
  assert.equal(lockfile.packages[""].version, packageJson.version);
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
