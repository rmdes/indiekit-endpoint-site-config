import { test } from "node:test";
import assert from "node:assert/strict";
import { scanPlugins } from "../lib/discovery/scan-plugins.js";
import { BUILTIN_SECTIONS } from "../lib/presets/builtin-sections.js";
import { BUILTIN_WIDGETS } from "../lib/presets/builtin-widgets.js";

function makeIndiekit(endpoints) {
  return {
    endpoints,
    config: { application: {} },
  };
}

test("scanPlugins seeds with built-ins when no endpoints", () => {
  const Indiekit = makeIndiekit([]);
  scanPlugins(Indiekit, null);
  assert.equal(Indiekit.config.application.discoveredSections.length, BUILTIN_SECTIONS.length);
  assert.equal(Indiekit.config.application.discoveredWidgets.length, BUILTIN_WIDGETS.length);
});

test("scanPlugins appends sections from endpoints with sourcePlugin tag", () => {
  const cvEndpoint = {
    name: "CV endpoint",
    homepageSections: [
      { id: "cv-experience", label: "Work Experience" },
    ],
  };
  const Indiekit = makeIndiekit([cvEndpoint]);
  scanPlugins(Indiekit, null);
  const cv = Indiekit.config.application.discoveredSections.find((s) => s.id === "cv-experience");
  assert.ok(cv);
  assert.equal(cv.sourcePlugin, "CV endpoint");
});

test("scanPlugins appends widgets from endpoints", () => {
  const gh = {
    name: "GitHub endpoint",
    homepageWidgets: [{ id: "github-projects", label: "Projects" }],
  };
  const Indiekit = makeIndiekit([gh]);
  scanPlugins(Indiekit, null);
  const w = Indiekit.config.application.discoveredWidgets.find((x) => x.id === "github-projects");
  assert.ok(w);
  assert.equal(w.sourcePlugin, "GitHub endpoint");
});

test("scanPlugins skips own endpoint", () => {
  const own = {
    name: "Site Config endpoint",
    homepageSections: [{ id: "should-not-appear", label: "Skip me" }],
  };
  const Indiekit = makeIndiekit([own]);
  scanPlugins(Indiekit, own);
  const found = Indiekit.config.application.discoveredSections.find((s) => s.id === "should-not-appear");
  assert.equal(found, undefined);
});

test("scanPlugins drops sections missing id or label", () => {
  const bad = {
    name: "Bad endpoint",
    homepageSections: [{ label: "No ID" }, { id: "no-label" }, { id: "valid", label: "Valid" }],
  };
  const Indiekit = makeIndiekit([bad]);
  scanPlugins(Indiekit, null);
  const valid = Indiekit.config.application.discoveredSections.filter((s) => s.sourcePlugin === "Bad endpoint");
  assert.equal(valid.length, 1);
  assert.equal(valid[0].id, "valid");
});

test("scanPlugins tolerates plugins whose getter throws", () => {
  const broken = {
    name: "Broken endpoint",
    get homepageSections() { throw new Error("kaboom"); },
  };
  const Indiekit = makeIndiekit([broken]);
  assert.doesNotThrow(() => scanPlugins(Indiekit, null));
  // Built-ins still present
  assert.equal(Indiekit.config.application.discoveredSections.length, BUILTIN_SECTIONS.length);
});

test("scanPlugins merges blog-post-widgets with sidebar widgets", () => {
  const Indiekit = makeIndiekit([]);
  scanPlugins(Indiekit, null);
  // discoveredBlogPostWidgets = blog-post-specific + all sidebar widgets
  assert.ok(Indiekit.config.application.discoveredBlogPostWidgets.length >= BUILTIN_WIDGETS.length);
});

// REPLACES the length-only idempotency test (the spec-flagged false negative):
test("scanPlugins is idempotent at CONTENT level (double-run produces identical results, no dup ids)", () => {
  const Indiekit = makeIndiekit([
    { name: "X", homepageSections: [{ id: "x-section", label: "X" }] },
  ]);
  scanPlugins(Indiekit, null);
  const first = structuredClone(Indiekit.config.application);
  scanPlugins(Indiekit, null);
  assert.deepEqual(Indiekit.config.application.discoveredSections, first.discoveredSections);
  assert.deepEqual(Indiekit.config.application.blockCatalog, first.blockCatalog);
  for (const list of [Indiekit.config.application.discoveredSections, Indiekit.config.application.blockCatalog]) {
    const ids = list.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate id detected");
  }
});

test("a plugin redeclaring a built-in id SHADOWS it (one entry, plugin's)", () => {
  const Indiekit = makeIndiekit([
    { name: "P", homepageSections: [{ id: "recent-posts", label: "My Recent Posts" }] },
  ]);
  scanPlugins(Indiekit, null);
  const matches = Indiekit.config.application.discoveredSections.filter((e) => e.id === "recent-posts");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].label, "My Recent Posts");
  const catalogMatches = Indiekit.config.application.blockCatalog.filter((e) => e.id === "recent-posts");
  assert.equal(catalogMatches.length, 1);
  assert.equal(catalogMatches[0].label, "My Recent Posts");
});

test("get blocks() entries pass the strict gate into the catalog; invalid ones are skipped whole", () => {
  const good = { id: "my-block", version: 1, label: "Mine",
    placement: { regions: ["main"] }, data: { source: "config" },
    schema: { type: "object", additionalProperties: false, properties: {} } };
  const Indiekit = makeIndiekit([
    { name: "P", blocks: [good, { id: "broken", label: "No schema" }] },
  ]);
  scanPlugins(Indiekit, null);
  const catalog = Indiekit.config.application.blockCatalog;
  assert.ok(catalog.find((e) => e.id === "my-block"));
  assert.equal(catalog.find((e) => e.id === "broken"), undefined);
});

test("a blocks-getter entry beats a legacy-getter entry for the same id (adapter shadowed)", () => {
  const block = { id: "dual", version: 1, label: "V2 wins",
    placement: { regions: ["main"] }, data: { source: "config" },
    schema: { type: "object", additionalProperties: false, properties: {} } };
  const Indiekit = makeIndiekit([
    { name: "P", blocks: [block], homepageSections: [{ id: "dual", label: "Legacy" }] },
  ]);
  scanPlugins(Indiekit, null);
  assert.equal(Indiekit.config.application.blockCatalog.find((e) => e.id === "dual").label, "V2 wins");
});

test("legacy getter entries are synthesized into the catalog with version 0 + legacy flag", () => {
  const Indiekit = makeIndiekit([
    { name: "CV endpoint", homepageSections: [{ id: "cv-experience", label: "Experience" }] },
  ]);
  scanPlugins(Indiekit, null);
  const entry = Indiekit.config.application.blockCatalog.find((e) => e.id === "cv-experience");
  assert.equal(entry.version, 0);
  assert.equal(entry.legacy, true);
  assert.deepEqual(entry.placement.regions, ["main"]);
  assert.equal(entry.sourcePlugin, "CV endpoint");
});

test("a throwing blocks getter skips that endpoint without killing the scan", () => {
  const Indiekit = makeIndiekit([
    { name: "Bad", get blocks() { throw new Error("boom"); } },
    { name: "Good", homepageSections: [{ id: "ok-section", label: "OK" }] },
  ]);
  scanPlugins(Indiekit, null);
  assert.ok(Indiekit.config.application.discoveredSections.find((e) => e.id === "ok-section"));
});

// ADDED REQUIREMENT (c): error containment is per-ENTRY, not only per-endpoint.
// A poisoned entry (throwing property getter) skips THAT ENTRY only — the
// plugin's remaining valid entries still land.
test("a blocks entry with a throwing property getter skips that entry only (per-entry containment)", () => {
  const good = { id: "survivor", version: 1, label: "Survivor",
    placement: { regions: ["main"] }, data: { source: "config" },
    schema: { type: "object", additionalProperties: false, properties: {} } };
  const Indiekit = makeIndiekit([
    { name: "P", blocks: [{ get id() { throw new Error("poison"); } }, good] },
  ]);
  assert.doesNotThrow(() => scanPlugins(Indiekit, null));
  assert.ok(Indiekit.config.application.blockCatalog.find((e) => e.id === "survivor"));
});

test("a legacy entry with a throwing property getter skips that entry only (per-entry containment)", () => {
  const Indiekit = makeIndiekit([
    {
      name: "P",
      homepageSections: [
        { get id() { throw new Error("poison"); } },
        { id: "legacy-survivor", label: "Still here" },
      ],
    },
  ]);
  assert.doesNotThrow(() => scanPlugins(Indiekit, null));
  assert.ok(Indiekit.config.application.discoveredSections.find((e) => e.id === "legacy-survivor"));
  assert.ok(Indiekit.config.application.blockCatalog.find((e) => e.id === "legacy-survivor"));
});

test("scanPlugins returns { catalog, sections, widgets, blogPostWidgets }", () => {
  const Indiekit = makeIndiekit([]);
  const result = scanPlugins(Indiekit, null);
  assert.deepEqual(result.catalog, Indiekit.config.application.blockCatalog);
  assert.deepEqual(result.sections, Indiekit.config.application.discoveredSections);
  assert.deepEqual(result.widgets, Indiekit.config.application.discoveredWidgets);
  assert.deepEqual(result.blogPostWidgets, Indiekit.config.application.discoveredBlogPostWidgets);
});

test("blockCatalog is sorted by id and seeded with built-in v2 entries", () => {
  const Indiekit = makeIndiekit([]);
  scanPlugins(Indiekit, null);
  const ids = Indiekit.config.application.blockCatalog.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
  assert.ok(ids.includes("hero"));
  assert.ok(ids.includes("recent-posts"));
});
