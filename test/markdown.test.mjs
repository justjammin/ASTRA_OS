// The gate documents are rendered with innerHTML, so escaping and link restriction are the
// contract this file protects.
import assert from "node:assert/strict";
import test from "node:test";
import { markdownToHtml, renderInline } from "../visualizer/template/markdown.js";

test("escapes markup in text, code, and fenced blocks", () => {
  assert.equal(renderInline("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(renderInline("call `<Widget/>`"), "call <code>&lt;Widget/&gt;</code>");
  assert.match(markdownToHtml("```js\nconst x = a < b && c > d;\n```"), /const x = a &lt; b &amp;&amp; c &gt; d;/);
  assert.match(markdownToHtml("```js\nconst x = 1;\n```"), /<pre data-language="js"><code>/);
});

test("renders headings shifted one level below the page title", () => {
  assert.equal(markdownToHtml("# Product"), "<h2>Product</h2>");
  assert.equal(markdownToHtml("### Slices"), "<h4>Slices</h4>");
});

test("renders paragraphs, lists, rules, and blockquotes", () => {
  assert.equal(markdownToHtml("one\ntwo\n\nthree"), "<p>one two</p>\n<p>three</p>");
  assert.equal(markdownToHtml("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(markdownToHtml("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(markdownToHtml("---"), "<hr />");
  assert.equal(markdownToHtml("> careful"), "<blockquote><p>careful</p></blockquote>");
});

test("renders pipe tables", () => {
  const html = markdownToHtml("| Gate | State |\n|---|---|\n| 1 | cleared |");
  assert.equal(
    html,
    '<div class="table-scroll"><table><thead><tr><th>Gate</th><th>State</th></tr></thead>' +
      "<tbody><tr><td>1</td><td>cleared</td></tr></tbody></table></div>",
  );
});

test("keeps emphasis but drops unsafe link targets", () => {
  assert.equal(renderInline("**bold** and *thin*"), "<strong>bold</strong> and <em>thin</em>");
  assert.match(renderInline("[docs](https://example.com)"), /<a href="https:\/\/example.com"[^>]*>docs<\/a>/);
  assert.match(renderInline("[rel](./docs/01-product.md)"), /<a href=".\/docs\/01-product.md"/);
  assert.equal(renderInline("[x](javascript:alert)"), "x", "javascript: target is dropped");
  assert.equal(renderInline("[x](data:text/html;base64,AA)"), "x", "data: target is dropped");
});
