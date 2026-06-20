import { test } from "node:test";
import assert from "node:assert/strict";
import { slugifyCategory, indexCategories } from "../lib/storage/category-census.js";

test("slugifyCategory collapses case + spaces + separators", () => {
  assert.equal(slugifyCategory("Politics"), "politics");
  assert.equal(slugifyCategory("Self-Hosting"), "self-hosting");
  assert.equal(slugifyCategory("  AI  "), "ai");
  assert.equal(slugifyCategory("C++"), "c");
  assert.equal(slugifyCategory(""), "");
  assert.equal(slugifyCategory(null), "");
});

test("indexCategories: per-slug count + variants + de-facto name = most-used", () => {
  const idx = indexCategories(["Politics", "politics", "politics"]);
  const p = idx.find((c) => c.slug === "politics");
  assert.equal(p.count, 3);
  assert.equal(p.name, "politics"); // 2 uses beats 1
  assert.deepEqual(p.variants, [
    { name: "politics", count: 2 },
    { name: "Politics", count: 1 },
  ]);
});

test("indexCategories flags merge candidates (variants.length > 1)", () => {
  const idx = indexCategories(["AI", "ai", "ai", "Solo"]);
  assert.equal(idx.find((c) => c.slug === "ai").variants.length, 2); // merge candidate
  assert.equal(idx.find((c) => c.slug === "solo").variants.length, 1); // clean
});

test("indexCategories handles arrays + ignores empty/non-string/malformed", () => {
  const idx = indexCategories([["a", "b"], "", null, {}, ["a"]]);
  assert.equal(idx.find((c) => c.slug === "a").count, 2);
  assert.equal(idx.find((c) => c.slug === "b").count, 1);
  assert.equal(idx.length, 2);
});

test("indexCategories sorts by count desc, then slug asc on ties", () => {
  const idx = indexCategories(["big", "big", "big", "zeta", "alpha"]);
  assert.equal(idx[0].slug, "big");
  assert.deepEqual(idx.slice(1).map((c) => c.slug), ["alpha", "zeta"]);
});

test("variant tie breaks deterministically by name (localeCompare)", () => {
  const idx = indexCategories(["ai", "AI"]); // 1 each
  const ai = idx.find((c) => c.slug === "ai");
  // Order is arbitrary but MUST be deterministic; localeCompare → lowercase first.
  assert.deepEqual(ai.variants.map((v) => v.name), ["ai", "AI"]);
});
