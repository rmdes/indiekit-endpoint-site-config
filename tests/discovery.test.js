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

/**
 * Silence scanner console output (repo convention: tests/block-entry.test.js)
 * and return the mocks so tests can assert the documented warn contract —
 * the warn IS part of the contract: a refactor that silently swallows
 * entries must fail the assertion-bearing tests below.
 */
function mockConsole(t) {
  return {
    warn: t.mock.method(console, "warn", () => {}),
    log: t.mock.method(console, "log", () => {}),
  };
}

/** True if at least one console.warn call's first argument matches pattern. */
function warned(warn, pattern) {
  return warn.mock.calls.some((call) => pattern.test(String(call.arguments[0])));
}

test("scanPlugins seeds with built-ins when no endpoints", (t) => {
  mockConsole(t);
  const Indiekit = makeIndiekit([]);
  scanPlugins(Indiekit, null);
  assert.equal(Indiekit.config.application.discoveredSections.length, BUILTIN_SECTIONS.length);
  assert.equal(Indiekit.config.application.discoveredWidgets.length, BUILTIN_WIDGETS.length);
});

test("scanPlugins appends sections from endpoints with sourcePlugin tag", (t) => {
  mockConsole(t);
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

test("scanPlugins appends widgets from endpoints", (t) => {
  mockConsole(t);
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

test("scanPlugins skips own endpoint", (t) => {
  mockConsole(t);
  const own = {
    name: "Site Config endpoint",
    homepageSections: [{ id: "should-not-appear", label: "Skip me" }],
  };
  const Indiekit = makeIndiekit([own]);
  scanPlugins(Indiekit, own);
  const found = Indiekit.config.application.discoveredSections.find((s) => s.id === "should-not-appear");
  assert.equal(found, undefined);
});

test("scanPlugins drops sections missing id or label", (t) => {
  mockConsole(t);
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

test("scanPlugins tolerates plugins whose getter throws", (t) => {
  mockConsole(t);
  const broken = {
    name: "Broken endpoint",
    get homepageSections() { throw new Error("kaboom"); },
  };
  const Indiekit = makeIndiekit([broken]);
  assert.doesNotThrow(() => scanPlugins(Indiekit, null));
  // Built-ins still present
  assert.equal(Indiekit.config.application.discoveredSections.length, BUILTIN_SECTIONS.length);
});

test("scanPlugins merges blog-post-widgets with sidebar widgets", (t) => {
  mockConsole(t);
  const Indiekit = makeIndiekit([]);
  scanPlugins(Indiekit, null);
  // discoveredBlogPostWidgets = blog-post-specific + all sidebar widgets
  assert.ok(Indiekit.config.application.discoveredBlogPostWidgets.length >= BUILTIN_WIDGETS.length);
});

// REPLACES the length-only idempotency test (the spec-flagged false negative):
test("scanPlugins is idempotent at CONTENT level (double-run produces identical results, no dup ids)", (t) => {
  mockConsole(t);
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

test("a plugin redeclaring a built-in id SHADOWS it (one entry, plugin's)", (t) => {
  mockConsole(t);
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

test("get blocks() entries pass the strict gate into the catalog; invalid ones are skipped whole", (t) => {
  const { warn } = mockConsole(t);
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
  // The warn is part of the documented contract (Task 2's error strings compose into it)
  assert.ok(
    warned(warn, /skipping invalid block "broken" from P: /),
    "expected the documented invalid-block warn",
  );
});

test("a blocks-getter entry beats a legacy-getter entry for the same id (adapter shadowed)", (t) => {
  mockConsole(t);
  const block = { id: "dual", version: 1, label: "V2 wins",
    placement: { regions: ["main"] }, data: { source: "config" },
    schema: { type: "object", additionalProperties: false, properties: {} } };
  const Indiekit = makeIndiekit([
    { name: "P", blocks: [block], homepageSections: [{ id: "dual", label: "Legacy" }] },
  ]);
  scanPlugins(Indiekit, null);
  assert.equal(Indiekit.config.application.blockCatalog.find((e) => e.id === "dual").label, "V2 wins");
});

test("two plugins declaring the same blocks id → one entry (last wins) + collision warn", (t) => {
  const { warn } = mockConsole(t);
  const entry = (label) => ({ id: "clash", version: 1, label,
    placement: { regions: ["main"] }, data: { source: "config" },
    schema: { type: "object", additionalProperties: false, properties: {} } });
  const Indiekit = makeIndiekit([
    { name: "First", blocks: [entry("From First")] },
    { name: "Second", blocks: [entry("From Second")] },
  ]);
  scanPlugins(Indiekit, null);
  const matches = Indiekit.config.application.blockCatalog.filter((e) => e.id === "clash");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].label, "From Second"); // last wins stays the rule
  assert.equal(matches[0].sourcePlugin, "Second");
  // ...but no longer silently — the collision warn is part of the contract.
  assert.ok(
    warned(warn, /block id "clash" declared by multiple plugins — Second wins/),
    "expected the cross-plugin collision warn",
  );
});

test("legacy getter entries are synthesized into the catalog with version 0 + legacy flag", (t) => {
  mockConsole(t);
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

test("a throwing blocks getter skips that endpoint without killing the scan", (t) => {
  const { warn } = mockConsole(t);
  const Indiekit = makeIndiekit([
    { name: "Bad", get blocks() { throw new Error("boom"); } },
    { name: "Good", homepageSections: [{ id: "ok-section", label: "OK" }] },
  ]);
  scanPlugins(Indiekit, null);
  assert.ok(Indiekit.config.application.discoveredSections.find((e) => e.id === "ok-section"));
  assert.ok(
    warned(warn, /plugin scan failed for Bad: boom/),
    "expected the per-endpoint containment warn",
  );
});

// ADDED REQUIREMENT (c): error containment is per-ENTRY, not only per-endpoint.
// A poisoned entry (throwing property getter) skips THAT ENTRY only — the
// plugin's remaining valid entries still land.
test("a blocks entry with a throwing property getter skips that entry only (per-entry containment)", (t) => {
  const { warn } = mockConsole(t);
  const good = { id: "survivor", version: 1, label: "Survivor",
    placement: { regions: ["main"] }, data: { source: "config" },
    schema: { type: "object", additionalProperties: false, properties: {} } };
  const Indiekit = makeIndiekit([
    { name: "P", blocks: [{ get id() { throw new Error("poison"); } }, good] },
  ]);
  assert.doesNotThrow(() => scanPlugins(Indiekit, null));
  assert.ok(Indiekit.config.application.blockCatalog.find((e) => e.id === "survivor"));
  assert.ok(
    warned(warn, /skipping unreadable block entry from P: poison/),
    "expected the per-entry containment warn",
  );
});

test("a legacy entry with a throwing property getter skips that entry only (per-entry containment)", (t) => {
  const { warn } = mockConsole(t);
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
  assert.ok(
    warned(warn, /skipping unreadable homepageSections entry from P: poison/),
    "expected the per-entry containment warn",
  );
});

// A throwing `name` getter must not defeat the catch levels: every warn path
// reads the name once via safeName, so the scan survives and siblings land.
test("a throwing name getter doesn't kill the scan (sibling endpoint entries still land)", (t) => {
  mockConsole(t);
  const Indiekit = makeIndiekit([
    {
      get name() { throw new Error("no name"); },
      get homepageSections() { throw new Error("kaboom"); },
    },
    { name: "Good", homepageSections: [{ id: "sibling-section", label: "Sibling" }] },
  ]);
  assert.doesNotThrow(() => scanPlugins(Indiekit, null));
  assert.ok(Indiekit.config.application.discoveredSections.find((e) => e.id === "sibling-section"));
});

test("scanPlugins returns { catalog, sections, widgets, blogPostWidgets }", (t) => {
  mockConsole(t);
  const Indiekit = makeIndiekit([]);
  const result = scanPlugins(Indiekit, null);
  assert.deepEqual(result.catalog, Indiekit.config.application.blockCatalog);
  assert.deepEqual(result.sections, Indiekit.config.application.discoveredSections);
  assert.deepEqual(result.widgets, Indiekit.config.application.discoveredWidgets);
  assert.deepEqual(result.blogPostWidgets, Indiekit.config.application.discoveredBlogPostWidgets);
});

test("blockCatalog is sorted by id and seeded with built-in v2 entries", (t) => {
  mockConsole(t);
  const Indiekit = makeIndiekit([]);
  scanPlugins(Indiekit, null);
  const ids = Indiekit.config.application.blockCatalog.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
  assert.ok(ids.includes("hero"));
  assert.ok(ids.includes("recent-posts"));
});
