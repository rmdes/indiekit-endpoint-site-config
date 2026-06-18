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

test("homepage carries NO supportsLivePreview field (retired #32 — live preview is per-surface)", () => {
  const entry = getSurface("homepage");
  assert.equal("supportsLivePreview" in entry, false);
});

test("homepage editor copy keys are the EXISTING editor.title/description (byte-identical)", () => {
  const entry = getSurface("homepage");
  assert.equal(entry.editorTitleKey, "siteConfig.design.editor.title");
  assert.equal(entry.editorIntroKey, "siteConfig.design.editor.description");
});

test("every live surface declares a per-surface editorNounKey (#39 — kills the 'homepage' copy leak)", () => {
  // The shared editor view interpolates {{surface}} from __(editorNounKey) into
  // confirm/draft/empty/custom/error copy, so each surface MUST supply a noun key.
  for (const routeKey of ["homepage", "listing", "posttype"]) {
    const entry = getSurface(routeKey);
    assert.equal(
      entry.editorNounKey,
      `siteConfig.design.editor.surfaceNoun.${routeKey}`,
      `${routeKey} editorNounKey`,
    );
  }
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

test("listing carries NO supportsLivePreview field (retired #32 — listing previews its own slot)", () => {
  const entry = getSurface("listing");
  assert.equal("supportsLivePreview" in entry, false);
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

// ---- getSurface: posttype entry (6.4) ----

test("getSurface('posttype') returns the posttype entry with the exact fields", () => {
  const entry = getSurface("posttype");
  assert.ok(entry, "posttype entry exists");
  // Vocabulary casing trap (6.4 CRITICAL): the route segment + hub key are
  // lowercase "posttype"; the composition kind + surface filter are camelCase
  // "postType" (matching builtin-blocks placement.surfaces + the SURFACES vocab).
  assert.equal(entry.routeKey, "posttype");
  assert.equal(entry.surfaceId, "posttype:default");
  assert.equal(entry.kind, "postType");
  assert.equal(entry.surfaceFilter, "postType");
  assert.equal(entry.hubKey, "posttype");
});

test("posttype entry wires the shared sidebarZoneModel by identity, with empty recipes and null treeBuilder", () => {
  const entry = getSurface("posttype");
  assert.equal(entry.zoneModel, sidebarZoneModel);
  assert.deepEqual(entry.recipes, []);
  assert.equal(entry.treeBuilder, null);
});

test("posttype declares NO arrangement capability (sidebar-only)", () => {
  const entry = getSurface("posttype");
  assert.equal("arrangements" in entry, false);
  assert.equal(entry.arrangements, undefined);
});

test("posttype carries NO supportsLivePreview field (retired #32 — posttype previews its own slot)", () => {
  const entry = getSurface("posttype");
  assert.equal("supportsLivePreview" in entry, false);
});

test("posttype declares its OWN editor copy keys", () => {
  const entry = getSurface("posttype");
  assert.equal(entry.editorTitleKey, "siteConfig.design.editor.posttypeTitle");
  assert.equal(entry.editorIntroKey, "siteConfig.design.editor.posttypeDescription");
});

test("getSurface('posttype') returns the same entry as SURFACES.posttype", () => {
  assert.equal(getSurface("posttype"), SURFACES.posttype);
});

test("the posttype entry is frozen", () => {
  assert.ok(Object.isFrozen(SURFACES.posttype));
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
