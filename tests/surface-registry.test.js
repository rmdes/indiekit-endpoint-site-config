import { test } from "node:test";
import assert from "node:assert/strict";
import { SURFACES, getSurface } from "../lib/editor/surface-registry.js";
import { homepageZoneModel } from "../lib/editor/zone-models/homepage.js";
import { sidebarZoneModel } from "../lib/editor/zone-models/sidebar.js";
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

test("homepage declares the live-preview capability (owns the shared slot)", () => {
  const entry = getSurface("homepage");
  assert.equal(entry.supportsLivePreview, true);
});

test("homepage editor copy keys are the EXISTING editor.title/description (byte-identical)", () => {
  const entry = getSurface("homepage");
  assert.equal(entry.editorTitleKey, "siteConfig.design.editor.title");
  assert.equal(entry.editorIntroKey, "siteConfig.design.editor.description");
});

test("getSurface('homepage') returns the same entry as SURFACES.homepage", () => {
  assert.equal(getSurface("homepage"), SURFACES.homepage);
});

// ---- getSurface: listing entry (6.3) ----

test("getSurface('listing') returns the listing entry with the exact fields", () => {
  const entry = getSurface("listing");
  assert.ok(entry, "listing entry exists");
  assert.equal(entry.routeKey, "listing");
  assert.equal(entry.surfaceId, "collection:default");
  assert.equal(entry.kind, "collection");
  assert.equal(entry.surfaceFilter, "collection");
  assert.equal(entry.hubKey, "listing");
});

test("listing entry wires the listing zoneModel by identity, with empty recipes and null treeBuilder", () => {
  const entry = getSurface("listing");
  assert.equal(entry.zoneModel, sidebarZoneModel);
  assert.deepEqual(entry.recipes, []);
  assert.equal(entry.treeBuilder, null);
});

test("listing declares NO arrangement capability (sidebar-only)", () => {
  const entry = getSurface("listing");
  assert.equal(entry.arrangements, undefined);
});

test("listing OMITS the live-preview capability (does not own the shared slot)", () => {
  const entry = getSurface("listing");
  assert.equal(entry.supportsLivePreview, undefined);
});

test("listing declares its OWN editor copy keys (not the homepage ones)", () => {
  const entry = getSurface("listing");
  assert.equal(entry.editorTitleKey, "siteConfig.design.editor.listingTitle");
  assert.equal(entry.editorIntroKey, "siteConfig.design.editor.listingDescription");
});

test("getSurface('listing') returns the same entry as SURFACES.listing", () => {
  assert.equal(getSurface("listing"), SURFACES.listing);
});

test("the listing entry is frozen", () => {
  assert.ok(Object.isFrozen(SURFACES.listing));
});

// ---- getSurface: unknown / prototype-safe ----

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
