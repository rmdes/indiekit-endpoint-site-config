import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_SECTIONS } from "../lib/presets/builtin-sections.js";
import { BUILTIN_WIDGETS } from "../lib/presets/builtin-widgets.js";
import { BUILTIN_BLOG_POST_WIDGETS } from "../lib/presets/builtin-blog-post-widgets.js";
import { LAYOUT_PRESETS } from "../lib/presets/layout-presets.js";

test("BUILTIN_SECTIONS exports 6 sections", () => {
  assert.equal(BUILTIN_SECTIONS.length, 6);
});

test("BUILTIN_SECTIONS all have id and label", () => {
  for (const s of BUILTIN_SECTIONS) {
    assert.ok(s.id && typeof s.id === "string");
    assert.ok(s.label && typeof s.label === "string");
  }
});

test("BUILTIN_SECTIONS IDs are unique", () => {
  const ids = BUILTIN_SECTIONS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("BUILTIN_WIDGETS exports 14 widgets", () => {
  assert.equal(BUILTIN_WIDGETS.length, 14);
});

test("BUILTIN_WIDGETS all have id and label", () => {
  for (const w of BUILTIN_WIDGETS) {
    assert.ok(w.id && typeof w.id === "string");
    assert.ok(w.label && typeof w.label === "string");
  }
});

test("BUILTIN_BLOG_POST_WIDGETS exports 6 entries", () => {
  assert.equal(BUILTIN_BLOG_POST_WIDGETS.length, 6);
});

test("LAYOUT_PRESETS includes blog, cv, hybrid", () => {
  const ids = LAYOUT_PRESETS.map((p) => p.id);
  assert.deepEqual(ids, ["blog", "cv", "hybrid"]);
});

test("LAYOUT_PRESETS each have layout + hero + sections + sidebar", () => {
  for (const p of LAYOUT_PRESETS) {
    assert.ok(["single-column", "two-column", "full-width-hero"].includes(p.layout));
    assert.ok(p.hero && typeof p.hero.enabled === "boolean");
    assert.ok(Array.isArray(p.sections));
    assert.ok(Array.isArray(p.sidebar));
  }
});
