import { test } from "node:test";
import assert from "node:assert/strict";
import { SURFACES, getSurface } from "../lib/editor/surface-registry.js";
import { homepageZoneModel } from "../lib/editor/zone-models/homepage.js";
import { LAYOUT_PRESETS } from "../lib/presets/layout-presets.js";
import { buildHomepageTree } from "../lib/storage/migrate-v3-to-v4.js";

// ---- getSurface: homepage entry ----

test("getSurface('homepage') returns the homepage entry with the exact fields", () => {
  const entry = getSurface("homepage");
  assert.ok(entry, "homepage entry exists");
  assert.equal(entry.routeKey, "homepage");
  assert.equal(entry.surfaceId, "homepage");
  assert.equal(entry.kind, "homepage");
  assert.equal(entry.surfaceFilter, "homepage");
  assert.equal(entry.editorView, "site-config-design-homepage");
  assert.equal(entry.hubKey, "homepage");
});

test("homepage entry wires the imported zoneModel/recipes/treeBuilder by identity", () => {
  const entry = getSurface("homepage");
  assert.equal(entry.zoneModel, homepageZoneModel);
  assert.equal(entry.recipes, LAYOUT_PRESETS);
  assert.equal(entry.treeBuilder, buildHomepageTree);
});

test("homepage declares the arrangement capability (stack + sidebar-right)", () => {
  const entry = getSurface("homepage");
  assert.deepEqual([...entry.arrangements], ["stack", "sidebar-right"]);
});

test("getSurface('homepage') returns the same entry as SURFACES.homepage", () => {
  assert.equal(getSurface("homepage"), SURFACES.homepage);
});

// ---- getSurface: not-live / unknown / prototype-safe ----

test("getSurface('listing') returns null (not a live 6.2 surface)", () => {
  assert.equal(getSurface("listing"), null);
});

test("getSurface('unknown') returns null", () => {
  assert.equal(getSurface("unknown"), null);
});

test("getSurface('__proto__') returns null (prototype keys do not leak)", () => {
  assert.equal(getSurface("__proto__"), null);
});

test("getSurface('constructor') returns null (prototype keys do not leak)", () => {
  assert.equal(getSurface("constructor"), null);
});

test("getSurface(undefined) returns null", () => {
  assert.equal(getSurface(undefined), null);
});

// ---- immutability (regression guard for 6.3+ which extend this registry) ----

test("SURFACES and its entries are frozen", () => {
  assert.ok(Object.isFrozen(SURFACES), "SURFACES registry is frozen");
  assert.ok(Object.isFrozen(SURFACES.homepage), "homepage entry is frozen");
});
