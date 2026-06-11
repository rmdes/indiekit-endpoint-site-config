import { test } from "node:test";
import assert from "node:assert/strict";
import { safeConfigUrl } from "../lib/validators/config-url.js";

test("accepts root-relative paths", () => {
  assert.equal(safeConfigUrl("/about/"), "/about/");
});
test("accepts https absolute urls", () => {
  assert.equal(safeConfigUrl("https://x.example/p"), "https://x.example/p");
});
test("rejects javascript: and data:", () => {
  assert.equal(safeConfigUrl("javascript:alert(1)"), null);
  assert.equal(safeConfigUrl("data:text/html,x"), null);
});
test("rejects localhost and RFC1918", () => {
  assert.equal(safeConfigUrl("http://127.0.0.1/x"), null);
  assert.equal(safeConfigUrl("http://localhost/x"), null);
  assert.equal(safeConfigUrl("http://192.168.1.1/x"), null);
  assert.equal(safeConfigUrl("http://10.0.0.5/x"), null);
  assert.equal(safeConfigUrl("http://172.16.4.4/x"), null);
});
test("rejects non-string and empty", () => {
  assert.equal(safeConfigUrl(undefined), null);
  assert.equal(safeConfigUrl("  "), null);
});
