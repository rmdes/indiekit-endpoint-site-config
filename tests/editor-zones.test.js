import { test } from "node:test";
import assert from "node:assert/strict";
import { treeToZones, zonesToTree } from "../lib/editor/zones.js";
import { homepageZoneModel } from "../lib/editor/zone-models/homepage.js";
import { buildHomepageTree } from "../lib/storage/migrate-v3-to-v4.js";
import { LAYOUT_PRESETS } from "../lib/presets/layout-presets.js";

// Deterministic id factory — same convention as tests/migrate-v3-to-v4.test.js.
const makeIds = () => { let n = 0; return (prefix) => `${prefix}_${String(++n).padStart(6, "0")}`; };

// The migrator-test V3 fixture (kept in sync with tests/migrate-v3-to-v4.test.js).
const V3 = {
  layout: "two-column",
  hero: { enabled: true, showSocial: true, ctaText: "Read more", ctaUrl: "/about/" },
  sections: [
    { type: "recent-posts", config: { maxItems: 10 } },
    { type: "hero", config: {} },
    { type: "posting-activity", config: {} },
  ],
  sidebar: [{ type: "author-card", config: {} }, { type: "categories", config: {} }],
  blogListingSidebar: [{ type: "recent-posts", config: { maxItems: 5 } }],
  blogPostSidebar: [],
  footer: [{ type: "custom-html", config: { content: "<p>bye</p>" } }],
};

// ---- treeToZones recognition ----

test("treeToZones maps the full two-column migrator tree to zones", () => {
  const tree = buildHomepageTree(V3, makeIds());
  const zones = treeToZones(tree);
  assert.equal(zones.custom, undefined);
  assert.equal(zones.arrangement, "sidebar-right");
  assert.equal(zones.hero.type, "hero");
  assert.deepEqual(zones.main.map((n) => n.type), ["recent-posts", "posting-activity"]);
  assert.deepEqual(zones.sidebar.map((n) => n.type), ["author-card", "categories"]);
  assert.deepEqual(zones.footer.map((n) => n.type), ["custom-html"]);
  // Container ids captured for lossless rebuild
  assert.equal(zones._containerIds.root, tree.id);
  assert.equal(zones._containerIds.columns, tree.children[1].id);
  assert.equal(zones._containerIds.main, tree.children[1].children[0].id);
  assert.equal(zones._containerIds.sidebar, tree.children[1].children[1].id);
  assert.equal(zones._containerIds.footer, tree.children[2].id);
});

test("treeToZones maps the single-column migrator tree (arrangement stack, no sidebar)", () => {
  const tree = buildHomepageTree({ ...V3, layout: "single-column" }, makeIds());
  const zones = treeToZones(tree);
  assert.equal(zones.custom, undefined);
  assert.equal(zones.arrangement, "stack");
  assert.deepEqual(zones.sidebar, []);
  assert.equal(zones._containerIds.columns, undefined);
  assert.equal(zones._containerIds.sidebar, undefined);
  assert.deepEqual(zones.main.map((n) => n.type), ["recent-posts", "posting-activity"]);
});

test("treeToZones: hero-less / footer-less trees map with empty slots", () => {
  const heroless = treeToZones(
    buildHomepageTree({ ...V3, hero: { ...V3.hero, enabled: false } }, makeIds()),
  );
  assert.equal(heroless.custom, undefined);
  assert.equal(heroless.hero, null);

  const footerless = treeToZones(buildHomepageTree({ ...V3, footer: [] }, makeIds()));
  assert.equal(footerless.custom, undefined);
  assert.deepEqual(footerless.footer, []);
  assert.equal(footerless._containerIds.footer, undefined);
});

test("treeToZones: empty main stack (hostile/empty v3) is still recognized", () => {
  const tree = buildHomepageTree({}, makeIds());
  const zones = treeToZones(tree);
  assert.equal(zones.custom, undefined);
  assert.deepEqual(zones.main, []);
  assert.equal(zones.arrangement, "stack");
});

// ---- the round-trip law ----

test("ROUND-TRIP LAW: migrator V3 fixture and all 3 presets survive treeToZones→zonesToTree deep-equal INCLUDING ids", () => {
  const sources = [V3, ...LAYOUT_PRESETS];
  for (const v3 of sources) {
    const tree = buildHomepageTree(v3, makeIds());
    const zones = treeToZones(tree);
    assert.equal(zones.custom, undefined, `wrongly custom: ${v3.id ?? "V3 fixture"}`);
    const rebuilt = zonesToTree(zones, { idFactory: makeIds() });
    assert.deepEqual(rebuilt, tree, `round-trip failed: ${v3.id ?? "V3 fixture"}`);
  }
});

test("ROUND-TRIP LAW: hero-less, sidebar-less and footer-less variants", () => {
  const variants = [
    { ...V3, hero: { ...V3.hero, enabled: false } },
    { ...V3, sidebar: [] },
    { ...V3, layout: "single-column" },
    { ...V3, footer: [] },
    { ...V3, hero: { enabled: false }, sidebar: [], footer: [] },
  ];
  for (const [index, v3] of variants.entries()) {
    const tree = buildHomepageTree(v3, makeIds());
    const zones = treeToZones(tree);
    assert.equal(zones.custom, undefined, `wrongly custom: variant ${index}`);
    assert.deepEqual(zonesToTree(zones, { idFactory: makeIds() }), tree, `variant ${index}`);
  }
});

// ---- custom (unrecognized) detection — strict, never throw ----

test("custom: extra root child after the contentinfo stack", () => {
  const tree = buildHomepageTree(V3, makeIds());
  const mangled = structuredClone(tree);
  mangled.children.push({
    block: "section", id: "b_extra", type: "custom-html", v: 0, config: {},
  });
  const zones = treeToZones(mangled);
  assert.equal(zones.custom, true);
  assert.equal(zones.tree, mangled); // original tree handed back for read-only render
});

test("custom: nested container inside a zone (main child is a container)", () => {
  const tree = buildHomepageTree(V3, makeIds());
  const mangled = structuredClone(tree);
  mangled.children[1].children[0].children.push({
    block: "container", id: "c_nested", as: "stack", role: "region", children: [],
  });
  assert.equal(treeToZones(mangled).custom, true);
});

test("custom: 1-2 columns variant (not the 2-1 migrator shape)", () => {
  const tree = buildHomepageTree(V3, makeIds());
  const mangled = structuredClone(tree);
  mangled.children[1].variant = { width: "default", columns: "1-2", gap: "loose" };
  assert.equal(treeToZones(mangled).custom, true);
});

test("custom: unknown/wrong role on a zone container", () => {
  const tree = buildHomepageTree(V3, makeIds());
  const mangled = structuredClone(tree);
  mangled.children[1].children[0].role = "banner"; // main stack role mangled
  assert.equal(treeToZones(mangled).custom, true);
});

test("custom: non-stack zone container (main as grid)", () => {
  const tree = buildHomepageTree({ ...V3, layout: "single-column" }, makeIds());
  const mangled = structuredClone(tree);
  mangled.children[1].as = "grid";
  assert.equal(treeToZones(mangled).custom, true);
});

test("custom: complementary stack missing the sticky variant", () => {
  const tree = buildHomepageTree(V3, makeIds());
  const mangled = structuredClone(tree);
  delete mangled.children[1].children[1].variant;
  assert.equal(treeToZones(mangled).custom, true);
});

test("custom: root-level section that is not a hero", () => {
  const tree = buildHomepageTree({ ...V3, hero: { enabled: false } }, makeIds());
  const mangled = structuredClone(tree);
  mangled.children.unshift({
    block: "section", id: "b_x", type: "recent-posts", v: 0, config: {},
  });
  assert.equal(treeToZones(mangled).custom, true);
});

test("custom: empty contentinfo stack (migrator never emits it; rebuild would drop it)", () => {
  const tree = buildHomepageTree({ ...V3, footer: [] }, makeIds());
  const mangled = structuredClone(tree);
  mangled.children.push({
    block: "container", id: "c_foot", as: "stack", role: "contentinfo", children: [],
  });
  assert.equal(treeToZones(mangled).custom, true);
});

test("custom: extra unknown keys on a container (rebuild would lose them)", () => {
  const tree = buildHomepageTree(V3, makeIds());
  const mangled = structuredClone(tree);
  mangled.children[1].children[0].experimental = true;
  assert.equal(treeToZones(mangled).custom, true);
});

test("treeToZones never throws on garbage input — returns custom", () => {
  for (const garbage of [null, undefined, 42, "tree", [], {}, { block: "section" },
    { block: "container", as: "stack", role: "root" /* no id/children */ }]) {
    const zones = treeToZones(garbage);
    assert.equal(zones.custom, true, JSON.stringify(garbage));
    assert.equal(zones.tree, garbage);
  }
});

// ---- zonesToTree id behavior ----

test("zonesToTree mints fresh container ids via idFactory when _containerIds is absent", () => {
  const zones = {
    arrangement: "sidebar-right",
    hero: null,
    main: [{ block: "section", id: "b_keep", type: "recent-posts", v: 0, config: {} }],
    sidebar: [{ block: "section", id: "b_side", type: "author-card", v: 0, config: {} }],
    footer: [],
  };
  const tree = zonesToTree(zones, { idFactory: makeIds() });
  assert.equal(tree.role, "root");
  assert.match(tree.id, /^c_/);
  const columns = tree.children[0];
  assert.match(columns.id, /^c_/);
  assert.deepEqual(columns.variant, { width: "default", columns: "2-1", gap: "loose" });
  const [main, complementary] = columns.children;
  assert.match(main.id, /^c_/);
  assert.deepEqual(complementary.variant, { sticky: true });
  // Section nodes pass through untouched, carrying their own ids
  assert.equal(main.children[0].id, "b_keep");
  assert.equal(complementary.children[0].id, "b_side");
  // All minted ids unique
  const ids = [tree.id, columns.id, main.id, complementary.id];
  assert.equal(new Set(ids).size, ids.length);
});

test("zonesToTree: stack arrangement with footer rebuilds without columns", () => {
  const zones = {
    arrangement: "stack",
    hero: { block: "section", id: "b_h", type: "hero", v: 0, config: {} },
    main: [],
    sidebar: [],
    footer: [{ block: "section", id: "b_f", type: "custom-html", v: 0, config: {} }],
    _containerIds: { root: "c_r", main: "c_m", footer: "c_f" },
  };
  const tree = zonesToTree(zones, { idFactory: makeIds() });
  assert.deepEqual(tree, {
    block: "container", id: "c_r", as: "stack", role: "root",
    children: [
      { block: "section", id: "b_h", type: "hero", v: 0, config: {} },
      { block: "container", id: "c_m", as: "stack", role: "main", children: [] },
      {
        block: "container", id: "c_f", as: "stack", role: "contentinfo",
        children: [{ block: "section", id: "b_f", type: "custom-html", v: 0, config: {} }],
      },
    ],
  });
});

test("zonesToTree: empty footer emits no contentinfo container even when a footer id lingers", () => {
  const tree = buildHomepageTree(V3, makeIds());
  const zones = treeToZones(tree);
  const edited = { ...zones, footer: [] }; // editor removed the last footer block
  const rebuilt = zonesToTree(edited, { idFactory: makeIds() });
  assert.equal(rebuilt.children.some((c) => c.role === "contentinfo"), false);
  // And the result still round-trips
  assert.deepEqual(zonesToTree(treeToZones(rebuilt), { idFactory: makeIds() }), rebuilt);
});

// ---- homepageZoneModel: the extracted zone-model object (6.2 foundation) ----

test("homepageZoneModel exposes the homepage zone vocabulary and region map", () => {
  assert.deepEqual(homepageZoneModel.zones, ["hero", "main", "sidebar", "footer"]);
  assert.deepEqual(homepageZoneModel.regionMap, {
    hero: "hero",
    main: "main",
    sidebar: "sidebar",
    footer: "footer",
  });
  assert.equal(typeof homepageZoneModel.recognize, "function");
  assert.equal(typeof homepageZoneModel.build, "function");
});

test("homepageZoneModel.recognize matches treeToZones on the full two-column tree", () => {
  const tree = buildHomepageTree(V3, makeIds());
  assert.deepEqual(homepageZoneModel.recognize(tree), treeToZones(tree));
});

test("homepageZoneModel.recognize returns custom for garbage, like treeToZones", () => {
  for (const garbage of [null, undefined, 42, "tree", [], {}, { block: "section" }]) {
    const direct = homepageZoneModel.recognize(garbage);
    assert.equal(direct.custom, true, JSON.stringify(garbage));
    assert.equal(direct.tree, garbage);
    assert.deepEqual(direct, treeToZones(garbage));
  }
});

test("homepageZoneModel.build matches zonesToTree (explicit idFactory in options)", () => {
  const tree = buildHomepageTree(V3, makeIds());
  const zones = homepageZoneModel.recognize(tree);
  const viaModel = homepageZoneModel.build(zones, { idFactory: makeIds() });
  const viaWrapper = zonesToTree(zones, { idFactory: makeIds() });
  assert.deepEqual(viaModel, viaWrapper);
  assert.deepEqual(viaModel, tree);
});

// ---- explicit-model wrapper calls: treeToZones(tree, model) / zonesToTree(zones, model, opts) ----

test("treeToZones(tree, homepageZoneModel) works when the model is passed explicitly", () => {
  const tree = buildHomepageTree(V3, makeIds());
  const explicit = treeToZones(tree, homepageZoneModel);
  const implicit = treeToZones(tree);
  assert.equal(explicit.custom, undefined);
  assert.deepEqual(explicit, implicit);
});

test("zonesToTree(zones, homepageZoneModel, {idFactory}) works when the model is passed explicitly", () => {
  const tree = buildHomepageTree(V3, makeIds());
  const zones = treeToZones(tree);
  const explicit = zonesToTree(zones, homepageZoneModel, { idFactory: makeIds() });
  assert.deepEqual(explicit, tree);
});

test("zonesToTree wrapper guard: old call style (options as 2nd arg) still works", () => {
  // design.js call site: zonesToTree(zones, { idFactory }) — options, not model.
  const tree = buildHomepageTree(V3, makeIds());
  const zones = treeToZones(tree);
  const oldStyle = zonesToTree(zones, { idFactory: makeIds() });
  const newStyle = zonesToTree(zones, homepageZoneModel, { idFactory: makeIds() });
  assert.deepEqual(oldStyle, tree);
  assert.deepEqual(oldStyle, newStyle);
});

test("zonesToTree wrapper guard: options bag with method-name lookalikes is NOT a model — idFactory is honored", () => {
  // Hardening: the overload guard sniffs the explicit `zoneModel: true`
  // sentinel, NOT the presence of build/recognize methods. An options object
  // that happens to carry build/recognize keys (no sentinel) must fall
  // through to the default homepage model so its idFactory is honored — not
  // be misclassified as a model (which would drop idFactory → undefined ids).
  const lookalike = {
    build() { throw new Error("must not be called — this is options, not a model"); },
    recognize() { throw new Error("must not be called — this is options, not a model"); },
    idFactory: makeIds(),
  };
  const tree = zonesToTree({
    arrangement: "stack",
    hero: null,
    main: [{ block: "section", id: "b_keep", type: "recent-posts", v: 0, config: {} }],
    sidebar: [],
    footer: [],
  }, lookalike);
  // The default model built the tree AND honored lookalike.idFactory: no
  // undefined ids anywhere.
  assert.equal(tree.role, "root");
  assert.match(tree.id, /^c_/);
  assert.match(tree.children[0].id, /^c_/);
  assert.equal(tree.children[0].children[0].id, "b_keep");
});

test("zonesToTree wrapper guard: real model with sentinel still routes to model.build", () => {
  const tree = buildHomepageTree(V3, makeIds());
  const zones = treeToZones(tree);
  assert.equal(homepageZoneModel.zoneModel, true); // sentinel present
  const explicit = zonesToTree(zones, homepageZoneModel, { idFactory: makeIds() });
  assert.deepEqual(explicit, tree);
});

// ---- ROUND-TRIP PROPERTY: every recognized shape survives build(recognize(t)) deep-equal incl. ids ----

test("ROUND-TRIP PROPERTY (zone-model): plain-stack and 2-1 columns, with/without hero/footer", () => {
  // Generate real migrator trees covering plain-stack (single-column) AND the
  // 2-1 columns/sidebar arrangement, each with/without hero and with/without footer.
  const sources = [];
  for (const layout of ["single-column", "two-column"]) {
    for (const heroEnabled of [true, false]) {
      for (const withFooter of [true, false]) {
        sources.push({
          ...V3,
          layout,
          hero: { ...V3.hero, enabled: heroEnabled },
          footer: withFooter ? V3.footer : [],
        });
      }
    }
  }
  for (const [index, v3] of sources.entries()) {
    const tree = buildHomepageTree(v3, makeIds());
    // Recognize via the model, rebuild via the model, deep-equal INCLUDING ids.
    const zones = homepageZoneModel.recognize(tree);
    assert.equal(zones.custom, undefined, `wrongly custom: source ${index} (${v3.layout})`);
    const rebuilt = homepageZoneModel.build(zones, { idFactory: makeIds() });
    assert.deepEqual(rebuilt, tree, `round-trip failed: source ${index} (${v3.layout})`);
    // And through the public wrappers with the explicit model, identically.
    assert.deepEqual(
      zonesToTree(treeToZones(tree, homepageZoneModel), homepageZoneModel, { idFactory: makeIds() }),
      tree,
      `wrapper round-trip failed: source ${index} (${v3.layout})`,
    );
  }
});
