import { test } from "node:test";
import assert from "node:assert/strict";
import { listingZoneModel } from "../lib/editor/zone-models/listing.js";

// Deterministic id factory — same convention as the homepage round-trip tests.
const makeIds = () => { let n = 0; return (prefix) => `${prefix}_${String(++n).padStart(6, "0")}`; };

// Hand-built seed tree mirroring the migrator's sidebarComposition output
// (migrate-v3-to-v4.js:161):
//   stack("root", [stack("complementary", <sections>, { sticky: true })])
// i.e. root stack whose ONLY child is a sticky complementary stack of sections.
const section = (id, type) => ({ block: "section", id, type, v: 0, config: {} });

const seedTree = (sections, ids = { root: "c_root", sidebar: "c_side" }) => ({
  block: "container",
  id: ids.root,
  as: "stack",
  role: "root",
  children: [
    {
      block: "container",
      id: ids.sidebar,
      as: "stack",
      role: "complementary",
      variant: { sticky: true },
      children: sections,
    },
  ],
});

const SECTIONS = [section("b_1", "recent-posts"), section("b_2", "categories")];

// ---- zone vocabulary ----

test("listingZoneModel exposes zoneModel:true, sidebar-only zones, and region map", () => {
  assert.equal(listingZoneModel.zoneModel, true);
  assert.deepEqual(listingZoneModel.zones, ["sidebar"]);
  assert.deepEqual(listingZoneModel.regionMap, { sidebar: "complementary" });
  assert.equal(typeof listingZoneModel.recognize, "function");
  assert.equal(typeof listingZoneModel.build, "function");
});

// ---- recognize: the seed shape ----

test("recognize maps the seed tree to a sidebar zone (no hero/main/footer/arrangement)", () => {
  const tree = seedTree(SECTIONS);
  const zones = listingZoneModel.recognize(tree);
  assert.equal(zones.custom, undefined);
  assert.deepEqual(zones.sidebar.map((n) => n.type), ["recent-posts", "categories"]);
  // No other zones from the homepage vocabulary leak in.
  assert.equal(zones.hero, undefined);
  assert.equal(zones.main, undefined);
  assert.equal(zones.footer, undefined);
  assert.equal(zones.arrangement, undefined);
  // Container ids captured for lossless rebuild.
  assert.equal(zones._containerIds.root, tree.id);
  assert.equal(zones._containerIds.sidebar, tree.children[0].id);
});

test("recognize handles an empty sidebar — single child still recognized", () => {
  // The migrator never seeds an empty-sidebar doc, but a tree whose
  // complementary stack has zero children is on-shape (allSections([]) === true).
  const tree = seedTree([]);
  const zones = listingZoneModel.recognize(tree);
  assert.equal(zones.custom, undefined);
  assert.deepEqual(zones.sidebar, []);
});

// ---- custom (off-shape) detection — strict like homepage ----

test("custom: homepage-shaped tree (hero + main, not sidebar-only)", () => {
  const tree = {
    block: "container", id: "c_root", as: "stack", role: "root",
    children: [
      section("b_hero", "hero"),
      { block: "container", id: "c_main", as: "stack", role: "main", children: [] },
    ],
  };
  const zones = listingZoneModel.recognize(tree);
  assert.equal(zones.custom, true);
  assert.equal(zones.tree, tree);
});

test("custom: root with two children (only a single complementary child is on-shape)", () => {
  const tree = seedTree(SECTIONS);
  const mangled = structuredClone(tree);
  mangled.children.push({
    block: "container", id: "c_extra", as: "stack", role: "complementary",
    variant: { sticky: true }, children: [],
  });
  assert.equal(listingZoneModel.recognize(mangled).custom, true);
});

test("custom: complementary stack missing the sticky variant", () => {
  const tree = seedTree(SECTIONS);
  const mangled = structuredClone(tree);
  delete mangled.children[0].variant;
  assert.equal(listingZoneModel.recognize(mangled).custom, true);
});

test("custom: complementary variant present but wrong (sticky:false)", () => {
  const tree = seedTree(SECTIONS);
  const mangled = structuredClone(tree);
  mangled.children[0].variant = { sticky: false };
  assert.equal(listingZoneModel.recognize(mangled).custom, true);
});

test("custom: sole child is not complementary (wrong role)", () => {
  const tree = seedTree(SECTIONS);
  const mangled = structuredClone(tree);
  mangled.children[0].role = "main";
  assert.equal(listingZoneModel.recognize(mangled).custom, true);
});

test("custom: non-section child inside the complementary stack (nested container)", () => {
  const tree = seedTree(SECTIONS);
  const mangled = structuredClone(tree);
  mangled.children[0].children.push({
    block: "container", id: "c_nested", as: "stack", role: "region", children: [],
  });
  assert.equal(listingZoneModel.recognize(mangled).custom, true);
});

test("custom: extra unknown key on the complementary container (rebuild would lose it)", () => {
  const tree = seedTree(SECTIONS);
  const mangled = structuredClone(tree);
  mangled.children[0].experimental = true;
  assert.equal(listingZoneModel.recognize(mangled).custom, true);
});

test("custom: root has zero children (no complementary child)", () => {
  const tree = { block: "container", id: "c_root", as: "stack", role: "root", children: [] };
  assert.equal(listingZoneModel.recognize(tree).custom, true);
});

test("recognize never throws on garbage input — returns custom", () => {
  for (const garbage of [null, undefined, 42, "tree", [], {}, { block: "section" },
    { block: "container", as: "stack", role: "root" /* no id/children */ }]) {
    const zones = listingZoneModel.recognize(garbage);
    assert.equal(zones.custom, true, JSON.stringify(garbage));
    assert.equal(zones.tree, garbage);
  }
});

// ---- ROUND-TRIP PROPERTY: build(recognize(t)) deep-equals t INCLUDING ids ----

test("ROUND-TRIP PROPERTY: seed trees with N sidebar sections survive recognize→build deep-equal incl. ids", () => {
  // Migrator emits only NON-EMPTY sidebar docs (empty → no doc); the round-trip
  // law covers exactly those shapes. The empty-sidebar inverse (build([]) →
  // root with empty children) is asserted separately below.
  const sources = [
    seedTree([section("b_1", "recent-posts")]),
    seedTree(SECTIONS),
    seedTree([section("b_1", "a"), section("b_2", "b"), section("b_3", "c")],
      { root: "c_rootX", sidebar: "c_sideX" }),
  ];
  for (const [index, tree] of sources.entries()) {
    const zones = listingZoneModel.recognize(tree);
    assert.equal(zones.custom, undefined, `wrongly custom: source ${index}`);
    const rebuilt = listingZoneModel.build(zones, { idFactory: makeIds() });
    assert.deepEqual(rebuilt, tree, `round-trip failed: source ${index}`);
  }
});

// ---- build: id minting + empty-sidebar inverse ----

test("build mints fresh container ids via idFactory when _containerIds is absent", () => {
  const zones = {
    sidebar: [section("b_keep", "recent-posts")],
  };
  const tree = listingZoneModel.build(zones, { idFactory: makeIds() });
  assert.equal(tree.role, "root");
  assert.equal(tree.as, "stack");
  assert.match(tree.id, /^c_/);
  const complementary = tree.children[0];
  assert.match(complementary.id, /^c_/);
  assert.equal(complementary.role, "complementary");
  assert.deepEqual(complementary.variant, { sticky: true });
  // Section passes through untouched, carrying its own id.
  assert.equal(complementary.children[0].id, "b_keep");
  // Minted ids unique.
  assert.notEqual(tree.id, complementary.id);
});

test("build with empty sidebar → root stack with empty children (migrator inverse: empty → no complementary container)", () => {
  const zones = { sidebar: [], _containerIds: { root: "c_r", sidebar: "c_s" } };
  const tree = listingZoneModel.build(zones, { idFactory: makeIds() });
  assert.deepEqual(tree, {
    block: "container", id: "c_r", as: "stack", role: "root", children: [],
  });
});
