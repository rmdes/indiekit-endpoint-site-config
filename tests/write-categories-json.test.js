import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCategoriesJson, writeCategoriesJson } from "../lib/render/write-categories-json.js";

test("renderCategoriesJson emits {threshold, overrides} with safe defaults", () => {
  assert.deepEqual(JSON.parse(renderCategoriesJson({})), { threshold: 2, overrides: {} });
  assert.deepEqual(
    JSON.parse(renderCategoriesJson({ categories: { threshold: 3, overrides: { ai: { feed: true } } } })),
    { threshold: 3, overrides: { ai: { feed: true } } },
  );
});

test("renderCategoriesJson coerces bad threshold to default 2", () => {
  assert.equal(JSON.parse(renderCategoriesJson({ categories: { threshold: 0 } })).threshold, 2);
  assert.equal(JSON.parse(renderCategoriesJson({ categories: { threshold: "x" } })).threshold, 2);
  assert.equal(JSON.parse(renderCategoriesJson({ categories: { threshold: 5 } })).threshold, 5);
});

test("renderCategoriesJson ignores non-object overrides", () => {
  assert.deepEqual(JSON.parse(renderCategoriesJson({ categories: { overrides: "nope" } })).overrides, {});
});

test("writeCategoriesJson atomically writes the artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cat-json-"));
  const out = join(dir, "categories.json");
  await writeCategoriesJson({ categories: { threshold: 4, overrides: { x: { listing: false } } } }, out);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { threshold: 4, overrides: { x: { listing: false } } });
  rmSync(dir, { recursive: true, force: true });
});
