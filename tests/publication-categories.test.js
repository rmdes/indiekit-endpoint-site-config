import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalNamesFromCensus,
  refreshPublicationCategories,
} from "../lib/storage/publication-categories.js";
import { indexCategories } from "../lib/storage/category-census.js";

// Category Governance, Layer 1 — wiring: site-config sets
// `Indiekit.publication.categories` to the census canonical names so
// normalise-on-write (and ?q=category autocomplete) fold to existing casing.

test("canonicalNamesFromCensus: sorted canonical names, drops empties/non-strings", () => {
  const census = indexCategories(["Politics", "politics", "AI", "ai", "Solo"]);
  // de-facto names: politics (2>1), AI? ai (1) vs AI (1) → tie → most-used logic;
  // assert membership + sort rather than exact casing of ties.
  const names = canonicalNamesFromCensus(census);
  assert.ok(names.includes("politics"));
  assert.ok(names.includes("Solo"));
  assert.deepEqual([...names].sort(), names); // already sorted
  assert.ok(!names.includes("")); // no empties
});

test("canonicalNamesFromCensus: one name per category (deduped by slug upstream)", () => {
  const census = indexCategories(["RSS", "rss", "rss"]);
  const names = canonicalNamesFromCensus(census);
  assert.equal(names.length, 1);
  assert.equal(names[0], "rss"); // 2 uses beats 1
});

test("refreshPublicationCategories: sets publication.categories from census", () => {
  const Indiekit = {
    config: { application: { contentDir: "/x" } },
    publication: { categories: [] },
  };
  const censusFn = () => indexCategories(["RSS", "IndieWeb"]);
  const applied = refreshPublicationCategories(Indiekit, { censusFn });
  assert.deepEqual(applied, ["IndieWeb", "RSS"]); // sorted
  assert.deepEqual(Indiekit.publication.categories, ["IndieWeb", "RSS"]);
});

test("refreshPublicationCategories: empty census does NOT clobber an existing list", () => {
  const Indiekit = {
    config: { application: { contentDir: "/x" } },
    publication: { categories: ["Preconfigured"] },
  };
  const applied = refreshPublicationCategories(Indiekit, { censusFn: () => [] });
  assert.deepEqual(applied, []);
  assert.deepEqual(Indiekit.publication.categories, ["Preconfigured"]); // untouched
});

test("refreshPublicationCategories: missing publication → no-op, no throw", () => {
  const Indiekit = { config: { application: { contentDir: "/x" } } };
  assert.deepEqual(refreshPublicationCategories(Indiekit, { censusFn: () => [] }), []);
});

test("refreshPublicationCategories: census throwing → swallowed, returns []", () => {
  const Indiekit = {
    config: { application: { contentDir: "/x" } },
    publication: { categories: ["Keep"] },
  };
  const censusFn = () => {
    throw new Error("fs blew up");
  };
  assert.deepEqual(refreshPublicationCategories(Indiekit, { censusFn }), []);
  assert.deepEqual(Indiekit.publication.categories, ["Keep"]); // unchanged
});
