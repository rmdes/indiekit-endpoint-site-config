import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCategoriesBody } from "../lib/controllers/categories.js";

test("parseCategoriesBody reads threshold (int >=1), defaults 2", () => {
  assert.equal(parseCategoriesBody({ threshold: "3" }).threshold, 3);
  assert.equal(parseCategoriesBody({ threshold: "0" }).threshold, 2);
  assert.equal(parseCategoriesBody({ threshold: "abc" }).threshold, 2);
  assert.equal(parseCategoriesBody({}).threshold, 2);
});

test("parseCategoriesBody maps per-category 3-state selects to overrides", () => {
  const { overrides } = parseCategoriesBody({
    override: {
      ai: { feed: "on", listing: "auto" }, // feed forced on, listing default
      politics: { feed: "off", listing: "off" }, // both forced off
      tech: { feed: "auto", listing: "auto" }, // no override
    },
  });
  assert.deepEqual(overrides, {
    ai: { feed: true },
    politics: { feed: false, listing: false },
  });
  assert.ok(!("tech" in overrides)); // all-auto → omitted
});

test("parseCategoriesBody rejects malformed slug keys", () => {
  const { overrides } = parseCategoriesBody({
    override: { "../etc": { feed: "on" }, "Bad Slug": { feed: "on" }, good: { feed: "on" } },
  });
  assert.deepEqual(Object.keys(overrides), ["good"]);
});

test("parseCategoriesBody tolerates missing/garbage override object", () => {
  assert.deepEqual(parseCategoriesBody({ override: "nope" }).overrides, {});
  assert.deepEqual(parseCategoriesBody({}).overrides, {});
});

import { buildMergeRenameMap } from "../lib/controllers/categories.js";

test("buildMergeRenameMap maps all variants except the chosen canonical", () => {
  const variants = [{ name: "politics", count: 12 }, { name: "Politics", count: 11 }, { name: "POLITICS", count: 1 }];
  assert.deepEqual(buildMergeRenameMap(variants, "politics"), { Politics: "politics", POLITICS: "politics" });
});

test("buildMergeRenameMap: single variant equal to canonical → empty map (no-op)", () => {
  assert.deepEqual(buildMergeRenameMap([{ name: "ai" }], "ai"), {});
});

test("buildMergeRenameMap tolerates missing/garbage variants", () => {
  assert.deepEqual(buildMergeRenameMap(undefined, "x"), {});
  assert.deepEqual(buildMergeRenameMap([{}, { name: 5 }, { name: "Real" }], "real"), { Real: "real" });
});
