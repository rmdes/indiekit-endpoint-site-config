import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_PRESETS } from "../lib/presets/layout-presets.js";

// Phase 7d — the legacy BUILTIN_SECTIONS / BUILTIN_WIDGETS / BUILTIN_BLOG_POST_WIDGETS
// presets were deleted with the legacy discovery subsystem (no consumer: the v3
// admin UI is retired, the theme reads block-catalog.json). Only the v4
// LAYOUT_PRESETS remain.

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
