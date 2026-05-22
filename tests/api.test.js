import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../lib/controllers/api.js";

test("escapeHtml handles all 5 dangerous HTML characters", () => {
  assert.equal(escapeHtml("&"), "&amp;");
  assert.equal(escapeHtml("<"), "&lt;");
  assert.equal(escapeHtml(">"), "&gt;");
  assert.equal(escapeHtml('"'), "&quot;");
  assert.equal(escapeHtml("'"), "&#39;");
});

test("escapeHtml neutralizes script tag injection (XSS regression test)", () => {
  const dangerous = '<script>alert("xss")</script>';
  const escaped = escapeHtml(dangerous);
  assert.ok(!escaped.includes("<script>"));
  assert.ok(!escaped.includes("</script>"));
  assert.ok(escaped.includes("&lt;script&gt;"));
});

test("escapeHtml handles attribute-context breakouts", () => {
  // An attacker trying to break out of an attribute value with "><script>
  const dangerous = '"><script>alert(1)</script>';
  const escaped = escapeHtml(dangerous);
  assert.ok(!escaped.includes('">'));
  assert.equal(escaped, '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
});

test("escapeHtml coerces non-string inputs via String()", () => {
  assert.equal(escapeHtml(null), "null");
  assert.equal(escapeHtml(undefined), "undefined");
  assert.equal(escapeHtml(42), "42");
});

test("escapeHtml preserves safe text", () => {
  assert.equal(escapeHtml("Hello, world!"), "Hello, world!");
  assert.equal(escapeHtml(""), "");
});
