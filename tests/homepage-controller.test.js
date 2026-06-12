import { test } from "node:test";
import assert from "node:assert/strict";
import {
  homepageRouter,
  parseEntryArray,
  sanitizeEntries,
  cap,
} from "../lib/controllers/homepage.js";

// Phase 4: the v3 homepage tab handlers (parseHomepageBody, detectActivePreset,
// GET render, POST save, apply-preset) are deleted — their tests went with
// them. What survives here: the shared zone-entry helpers blog.js consumes
// (also exercised end-to-end via tests/blog-controller.test.js) and the
// legacy-URL redirect.

// ---- parseEntryArray (surviving export, consumed by blog.js) ----

test("parseEntryArray handles JSON string from hidden input", () => {
  const json = JSON.stringify([{ type: "hero", config: {} }]);
  const result = parseEntryArray(json);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "hero");
});

test("parseEntryArray returns input array unchanged when already array", () => {
  const input = [{ type: "recent-posts", config: { maxItems: 10 } }];
  const result = parseEntryArray(input);
  assert.deepEqual(result, input);
});

test("parseEntryArray handles indexed object form", () => {
  const input = {
    "0": { type: "hero", config: {} },
    "1": { type: "recent-posts", config: {} },
  };
  const result = parseEntryArray(input);
  assert.equal(result.length, 2);
});

test("parseEntryArray returns empty array for missing/invalid", () => {
  assert.deepEqual(parseEntryArray(null), []);
  assert.deepEqual(parseEntryArray(undefined), []);
  assert.deepEqual(parseEntryArray("not json"), []);
});

// ---- sanitizeEntries / cap (surviving exports, consumed by blog.js) ----

test("sanitizeEntries strips scripts and bounds custom-html content", () => {
  const entries = [
    { type: "custom-html", config: { content: "<p>ok</p><script>alert(1)</script>" } },
    { type: "custom-html", config: { content: "a".repeat(30000) } },
  ];
  const out = sanitizeEntries(entries);
  assert.equal(out[0].config.content.includes("<script"), false);
  assert.ok(out[1].config.content.length <= 20000);
});

test("sanitizeEntries coerces a non-string title to a bounded string", () => {
  const out = sanitizeEntries([{ type: "search", config: { title: { evil: 1 } } }]);
  assert.equal(typeof out[0].config.title, "string");
  assert.ok(out[0].config.title.length <= 200);
});

test("cap limits a zone to 24 entries", () => {
  const many = Array.from({ length: 40 }, () => ({ type: "recent-posts", config: {} }));
  assert.equal(cap(many).length, 24);
});

// ---- the retired tab redirects to the design editor ----

test("GET /site-config/homepage → 303 to the design editor homepage surface", async () => {
  const router = homepageRouter();
  const result = await new Promise((resolve, reject) => {
    const req = { method: "GET", url: "/", body: {} };
    const res = { redirect(status, location) { resolve({ status, location }); } };
    router.handle(req, res, (error) =>
      reject(error ?? new Error("route fell through")),
    );
  });
  assert.deepEqual(result, { status: 303, location: "/site-config/design/homepage" });
});

test("POST /site-config/homepage no longer exists (falls through the router)", async () => {
  const router = homepageRouter();
  const fellThrough = await new Promise((resolve, reject) => {
    const req = { method: "POST", url: "/", body: {} };
    const res = { redirect() { reject(new Error("POST handler should be gone")); } };
    router.handle(req, res, (error) => (error ? reject(error) : resolve(true)));
  });
  assert.equal(fellThrough, true);
});
