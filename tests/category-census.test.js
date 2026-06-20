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

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { censusFromContentDir, invalidateCensusCache } from "../lib/storage/category-census.js";

test("censusFromContentDir reads .md frontmatter categories recursively", () => {
  const dir = mkdtempSync(join(tmpdir(), "census-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "a.md"), "---\ncategory: Politics\n---\nbody");
  writeFileSync(join(dir, "notes", "b.md"), "---\ncategory: politics\n---\nbody");
  writeFileSync(join(dir, "notes", "c.md"), "---\ncategory:\n  - AI\n  - politics\n---\nbody");
  writeFileSync(join(dir, "d.md"), "---\ntitle: no category\n---\nbody");
  invalidateCensusCache();
  const idx = censusFromContentDir(dir, { ttl: 0 });
  assert.equal(idx.find((c) => c.slug === "politics").count, 3);
  assert.equal(idx.find((c) => c.slug === "ai").count, 1);
  // variants surface the casing split for the merge UI
  assert.equal(idx.find((c) => c.slug === "politics").variants.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("censusFromContentDir returns [] for a missing dir", () => {
  assert.deepEqual(censusFromContentDir(join(tmpdir(), "no-such-census-xyz"), { ttl: 0 }), []);
});
