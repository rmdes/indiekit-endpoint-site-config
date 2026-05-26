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

test("scanPlugins is idempotent (can be called twice without duplicating)", () => {
  const Indiekit = makeIndiekit([
    { name: "X", homepageSections: [{ id: "x-section", label: "X" }] },
  ]);
  scanPlugins(Indiekit, null);
  const firstCount = Indiekit.config.application.discoveredSections.length;
  scanPlugins(Indiekit, null);
  assert.equal(Indiekit.config.application.discoveredSections.length, firstCount);
});
