import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const read = (file) => readFile(resolve(root, file), "utf8");

test("recruiter site exposes the complete product narrative", async () => {
  const html = await read("site/index.html");
  for (const id of ["overview", "gates", "session", "context", "budget", "verification", "workflow", "faq", "install"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing section #${id}`);
  }
  assert.equal((html.match(/class="gate-item/g) ?? []).length, 5, "site should describe all five gates");
  assert.match(html, /SoftwareApplication/);
  assert.match(html, /HowTo/);
  assert.match(html, /FAQPage/);
  assert.match(html, /rel="canonical" href="\.\/"/);
  assert.doesNotMatch(html, /justjammin\.github\.io/);
});

test("motion stays pinned, finite, and accessible", async () => {
  const html = await read("site/index.html");
  const script = await read("site/script.js");
  assert.match(html, /gsap@3\.14\.2\/dist\/gsap\.min\.js/);
  assert.doesNotMatch(html, /integrity=/, "unverified CDN integrity should not block the pinned script");
  assert.match(script, /IntersectionObserver/);
  assert.match(script, /matchMedia\(\)/);
  assert.doesNotMatch(script, /ScrollTrigger/);
  assert.match(await read("site/styles.css"), /prefers-reduced-motion/);
});

test("Cloudflare/static discovery assets are present", async () => {
  const [config, headers, robots, llms, manifest] = await Promise.all([
    read("site.wrangler.jsonc"),
    read("site/_headers"),
    read("site/robots.txt"),
    read("site/llms.txt"),
    read("site/manifest.webmanifest"),
  ]);
  assert.match(config, /"directory":\s*"\.\/site"/);
  assert.match(headers, /Content-Security-Policy/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(robots, /User-agent: \*/);
  assert.match(llms, /five front-loaded software-factory gates/i);
  assert.deepEqual(JSON.parse(manifest).start_url, "./");
});
