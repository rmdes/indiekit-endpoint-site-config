import { test } from "node:test";
import assert from "node:assert/strict";
import { scanPlugins } from "../lib/discovery/scan-plugins.js";
import { BUILTIN_BLOCKS } from "../lib/presets/builtin-blocks.js";

function makeIndiekit(endpoints) {
  return {
    endpoints,
    config: { application: {} },
  };
}

/** A minimal valid v2 block entry for tests that need to seed the catalog. */
function v2Block(id, label, region = "main") {
  return {
    id,
    version: 1,
    label,
    placement: { regions: [region], surfaces: ["homepage"] },
    multiple: true,
    data: { source: "config" },
    schema: { type: "object", additionalProperties: false, properties: {} },
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
  const result = scanPlugins(Indiekit, null);
  assert.equal(Indiekit.config.application.blockCatalog.length, BUILTIN_BLOCKS.length);
  assert.deepEqual(result.catalog, Indiekit.config.application.blockCatalog);
});

test("scanPlugins skips own endpoint", (t) => {
  mockConsole(t);
  const own = {
    name: "Site Config endpoint",
    blocks: [v2Block("should-not-appear", "Skip me")],
  };
  const Indiekit = makeIndiekit([own]);
  scanPlugins(Indiekit, own);
  const found = Indiekit.config.application.blockCatalog.find((s) => s.id === "should-not-appear");
  assert.equal(found, undefined);
});

test("scanPlugins tolerates plugins whose getter throws", (t) => {
  mockConsole(t);
  const broken = {
    name: "Broken endpoint",
    get blocks() { throw new Error("kaboom"); },
  };
  const Indiekit = makeIndiekit([broken]);
  assert.doesNotThrow(() => scanPlugins(Indiekit, null));
  // Built-ins still present
  assert.equal(Indiekit.config.application.blockCatalog.length, BUILTIN_BLOCKS.length);
});

// REPLACES the length-only idempotency test (the spec-flagged false negative):
test("scanPlugins is idempotent at CONTENT level (double-run produces identical results, no dup ids)", (t) => {
  mockConsole(t);
  const Indiekit = makeIndiekit([
    { name: "X", blocks: [v2Block("x-section", "X")] },
  ]);
  scanPlugins(Indiekit, null);
  const first = structuredClone(Indiekit.config.application);
  scanPlugins(Indiekit, null);
  assert.deepEqual(Indiekit.config.application.blockCatalog, first.blockCatalog);
  for (const list of [Indiekit.config.application.blockCatalog]) {
    const ids = list.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate id detected");
  }
});

test("a plugin redeclaring a built-in id SHADOWS it (one entry, plugin's)", (t) => {
  mockConsole(t);
  const Indiekit = makeIndiekit([
    { name: "P", blocks: [v2Block("recent-posts", "My Recent Posts")] },
  ]);
  scanPlugins(Indiekit, null);
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

test("a throwing blocks getter skips that endpoint without killing the scan", (t) => {
  const { warn } = mockConsole(t);
  const Indiekit = makeIndiekit([
    { name: "Bad", get blocks() { throw new Error("boom"); } },
    { name: "Good", blocks: [v2Block("ok-section", "OK")] },
  ]);
  scanPlugins(Indiekit, null);
  assert.ok(Indiekit.config.application.blockCatalog.find((e) => e.id === "ok-section"));
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

// A throwing `name` getter must not defeat the catch levels: every warn path
// reads the name once via safeName, so the scan survives and siblings land.
test("a throwing name getter doesn't kill the scan (sibling endpoint entries still land)", (t) => {
  mockConsole(t);
  const Indiekit = makeIndiekit([
    {
      get name() { throw new Error("no name"); },
      get blocks() { throw new Error("kaboom"); },
    },
    { name: "Good", blocks: [v2Block("sibling-section", "Sibling")] },
  ]);
  assert.doesNotThrow(() => scanPlugins(Indiekit, null));
  assert.ok(Indiekit.config.application.blockCatalog.find((e) => e.id === "sibling-section"));
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
