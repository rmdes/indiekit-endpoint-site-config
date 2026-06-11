import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeCustomHtml } from "../lib/sanitize/custom-html.js";

test("strips script tags", () => {
  assert.equal(sanitizeCustomHtml("<p>hi</p><script>alert(1)</script>").includes("<script"), false);
});
test("strips javascript: hrefs", () => {
  const out = sanitizeCustomHtml('<a href="javascript:alert(1)">x</a>');
  assert.equal(out.includes("javascript:"), false);
});
test("strips event handler attributes", () => {
  assert.equal(sanitizeCustomHtml('<img src=x onerror="alert(1)">').includes("onerror"), false);
});
test("strips iframe and link/meta (no endpoint hijack)", () => {
  const out = sanitizeCustomHtml('<iframe src="x"></iframe><link rel="webmention" href="x"><p>ok</p>');
  assert.equal(out.includes("<iframe"), false);
  assert.equal(out.includes("<link"), false);
  assert.equal(out.includes('rel="webmention"'), false);
});
test("keeps rich formatting, tables, and links", () => {
  const out = sanitizeCustomHtml('<h2>T</h2><p><strong>b</strong> <a href="https://x.example/">l</a></p><table><tr><td>c</td></tr></table>');
  assert.equal(out.includes("<strong>"), true);
  assert.equal(out.includes("<table>"), true);
  assert.equal(out.includes("https://x.example/"), true);
});
test("non-string input returns empty string", () => {
  assert.equal(sanitizeCustomHtml(undefined), "");
  assert.equal(sanitizeCustomHtml(42), "");
});
