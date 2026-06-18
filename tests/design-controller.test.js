import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nunjucks from "nunjucks";
import {
  designRouter,
  parseAddBody,
  parseZone,
  placementAllows,
  encodeUndoPayload,
  parseUndoPayload,
  groupAvailableBlocks,
  decorateZones,
  typePresent,
  findNode,
  readFlash,
  isStuckBuild,
  mergeBuildStatus,
  buildStatusHandler,
} from "../lib/controllers/design.js";
import { readBuildStatus } from "../lib/storage/read-build-status.js";
import { treeToZones } from "../lib/editor/zones.js";
import { homepageZoneModel } from "../lib/editor/zone-models/homepage.js";
import { listingZoneModel } from "../lib/editor/zone-models/sidebar.js";
import { getSurface } from "../lib/editor/surface-registry.js";
import { BUILTIN_BLOCKS } from "../lib/presets/builtin-blocks.js";
import { LAYOUT_PRESETS } from "../lib/presets/layout-presets.js";

const makeIds = () => { let n = 0; return (prefix) => `${prefix}_${String(++n).padStart(6, "0")}`; };

// The homepage surface's zone vocabulary, threaded into the now model-driven
// pure seams (parseZone/placementAllows/parseUndoPayload).
const HP_ZONES = homepageZoneModel.zones;
const HP_REGION_MAP = homepageZoneModel.regionMap;

// ---- stubs ----

// Multi-collection db stub: compositions follows the composition-draft test
// conventions (filter-aware updateOne with upsert/$setOnInsert, replaceOne
// forbidden); siteConfig allows replaceOne (saveSiteConfig's documented
// convention).
function makeDb(seed = {}) {
  const stores = {};
  for (const [name, docs] of Object.entries(seed)) {
    stores[name] = new Map(docs.map((doc) => [doc._id, structuredClone(doc)]));
  }
  return {
    stores,
    collection(name) {
      const store = stores[name] ?? (stores[name] = new Map());
      return {
        async findOne({ _id }) {
          return store.get(_id) ?? null;
        },
        async updateOne(filter, update, options = {}) {
          const doc = store.get(filter._id);
          const matches =
            doc &&
            Object.entries(filter).every(([key, cond]) => {
              if (key === "_id") return true;
              if (cond && typeof cond === "object" && "$exists" in cond) {
                return (key in doc) === cond.$exists;
              }
              return doc[key] === cond;
            });
          if (!matches) {
            if (options.upsert && !store.has(filter._id)) {
              const inserted = { _id: filter._id };
              for (const [k, v] of Object.entries(update.$setOnInsert ?? {})) inserted[k] = v;
              for (const [k, v] of Object.entries(update.$set ?? {})) inserted[k] = v;
              for (const [k, v] of Object.entries(update.$inc ?? {})) inserted[k] = (inserted[k] ?? 0) + v;
              store.set(filter._id, inserted);
              return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
            }
            return { matchedCount: 0, modifiedCount: 0 };
          }
          for (const [k, v] of Object.entries(update.$set ?? {})) doc[k] = v;
          for (const [k, v] of Object.entries(update.$inc ?? {})) doc[k] = (doc[k] ?? 0) + v;
          for (const k of Object.keys(update.$unset ?? {})) delete doc[k];
          return { matchedCount: 1, modifiedCount: 1 };
        },
        // preview-state's bumpRevision (driver v6 shape: returns the doc).
        async findOneAndUpdate(filter, update, options = {}) {
          let doc = store.get(filter._id);
          if (!doc) {
            if (!options.upsert) return null;
            doc = { _id: filter._id };
            for (const [k, v] of Object.entries(update.$setOnInsert ?? {})) doc[k] = v;
            store.set(filter._id, doc);
          }
          for (const [k, v] of Object.entries(update.$set ?? {})) doc[k] = v;
          for (const [k, v] of Object.entries(update.$inc ?? {})) doc[k] = (doc[k] ?? 0) + v;
          return structuredClone(doc);
        },
        async replaceOne({ _id }, doc, options = {}) {
          if (name === "compositions") {
            throw new Error("replaceOne forbidden on compositions");
          }
          if (!options.upsert && !store.has(_id)) {
            throw new Error(`replaceOne without upsert: no doc ${_id}`);
          }
          store.set(_id, structuredClone(doc));
        },
      };
    },
  };
}

const EMPTY_SCHEMA = { type: "object", additionalProperties: false, properties: {} };

// 3 real builtins (hero multiple:false hero-region; recent-posts main+sidebar;
// custom-html main+sidebar+footer) + a live legacy plugin block with a
// defaultConfig + a dormant legacy block (plugin not loaded).
const CATALOG = [
  ...BUILTIN_BLOCKS.filter((b) => ["hero", "recent-posts", "custom-html"].includes(b.id)),
  {
    id: "cv-experience", version: 0, legacy: true, label: "Experience", icon: "briefcase",
    category: "plugin", placement: { regions: ["main"], surfaces: ["homepage"] },
    multiple: true,
    schema: {
      type: "object", additionalProperties: false,
      properties: { maxItems: { type: "integer", minimum: 1, maximum: 50 } },
    },
    defaultConfig: { maxItems: 3 },
    data: { source: "config" }, sourcePlugin: "CV endpoint",
  },
  {
    id: "ghost-widget", version: 0, legacy: true, label: "Ghost", icon: "",
    category: "plugin", placement: { regions: ["sidebar"], surfaces: ["homepage"] },
    multiple: true, schema: EMPTY_SCHEMA, data: { source: "config" },
    sourcePlugin: "Removed endpoint",
  },
];

const section = (id, type, config = {}) => ({ block: "section", id, type, v: 0, config });

const baseTree = () => ({
  block: "container", id: "c_root", as: "stack", role: "root",
  children: [
    section("b_hero", "hero", { showSocial: true }),
    {
      block: "container", id: "c_cols", as: "columns", role: "region",
      variant: { width: "default", columns: "2-1", gap: "loose" },
      children: [
        {
          block: "container", id: "c_main", as: "stack", role: "main",
          children: [section("b_m1", "recent-posts", { maxItems: 10 }), section("b_m2", "custom-html", {})],
        },
        {
          block: "container", id: "c_side", as: "stack", role: "complementary",
          variant: { sticky: true },
          children: [section("b_s1", "recent-posts", { maxItems: 5 })],
        },
      ],
    },
  ],
});

const customTree = () => {
  const tree = baseTree();
  tree.children.push(section("b_extra", "custom-html", {})); // extra root child ⇒ custom
  return tree;
};

const homepageDoc = (extra = {}) => ({
  _id: "homepage", schemaVersion: 4, kind: "homepage", status: "published",
  tree: baseTree(), updatedAt: "2026-06-01T00:00:00.000Z", updatedBy: "test", ...extra,
});

function makeIndiekit({ compositions = [homepageDoc()], siteConfig = [], catalog = CATALOG, endpoints } = {}) {
  const db = makeDb({ compositions, siteConfig });
  return {
    database: db,
    _db: db,
    endpoints: endpoints ?? [{ name: "CV endpoint" }],
    config: {
      application: { blockCatalog: catalog },
      publication: { me: "https://example.test" },
    },
  };
}

function makeRouter(ik, overrides = {}) {
  return designRouter(ik, {
    idFactory: makeIds(),
    // Tests must never write the real preview artifact to /app/data.
    writePreviewArtifact: async () => {},
    ...overrides,
  });
}

function callRoute(router, method, url, body = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url, "http://localhost");
    const req = {
      method: method.toUpperCase(),
      url,
      body,
      headers,
      query: Object.fromEntries(parsed.searchParams),
    };
    const res = {
      statusCode: 200,
      redirected: null,
      rendered: null,
      body: null,
      jsonBody: null,
      headers: {},
      set(name, value) { this.headers[name] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      send(payload) { this.body = payload; resolve(this); },
      json(payload) { this.jsonBody = payload; resolve(this); },
      redirect(status, target) {
        this.redirected = target === undefined
          ? { status: 302, url: status }
          : { status, url: target };
        resolve(this);
      },
      render(view, locals) { this.rendered = { view, locals }; resolve(this); },
    };
    router.handle(req, res, (error) =>
      reject(error ?? new Error(`unhandled ${method} ${url}`)),
    );
  });
}

const draftZones = (ik) => treeToZones(ik._db.stores.compositions.get("homepage").draftTree);
const flag = (res, name) => new URL(res.redirected.url, "http://x").searchParams.get(name);

// ---- pure helpers ----

test("parseZone accepts the four zones only (model-driven)", () => {
  for (const zone of ["hero", "main", "sidebar", "footer"]) assert.equal(parseZone(zone, HP_ZONES), zone);
  for (const bad of ["root", "", undefined, null, "MAIN", 3]) assert.equal(parseZone(bad, HP_ZONES), null);
  // accepts either a list or a Set as the zone vocabulary
  assert.equal(parseZone("main", new Set(HP_ZONES)), "main");
});

test("parseAddBody validates zone before type (zone errors win)", () => {
  assert.deepEqual(parseAddBody({ zone: "main", type: "hero" }, HP_ZONES), { zone: "main", type: "hero" });
  assert.deepEqual(parseAddBody({ zone: "attic", type: "hero" }, HP_ZONES), { error: "invalid-zone" });
  assert.deepEqual(parseAddBody({ zone: "main" }, HP_ZONES), { error: "unknown-type" });
  assert.deepEqual(parseAddBody(undefined, HP_ZONES), { error: "invalid-zone" });
});

test("placementAllows maps zones to placement regions (model-driven)", () => {
  const hero = CATALOG.find((e) => e.id === "hero");
  const recent = CATALOG.find((e) => e.id === "recent-posts");
  assert.equal(placementAllows(hero, "hero", HP_REGION_MAP), true);
  assert.equal(placementAllows(hero, "main", HP_REGION_MAP), false);
  assert.equal(placementAllows(recent, "main", HP_REGION_MAP), true);
  assert.equal(placementAllows(recent, "footer", HP_REGION_MAP), false);
  assert.equal(placementAllows(undefined, "main", HP_REGION_MAP), false);
});

test("placementAllows: listing regionMap makes sidebar blocks placeable, main-only blocks not (6.3 CRITICAL regression)", () => {
  // The listing surface is sidebar-only. Its regionMap MUST map editor zone
  // "sidebar" → placement region "sidebar" (NOT the tree role "complementary"):
  // sidebar-capable blocks declare regions:["sidebar"], so a regionMap of
  // {sidebar:"complementary"} makes placementAllows reject EVERY block → an
  // unusable listing editor. This test fails under the broken regionMap.
  const LISTING_REGION_MAP = listingZoneModel.regionMap;
  // Realistic collection-surface sidebar blocks (regions incl. "sidebar").
  const authorCard = BUILTIN_BLOCKS.find((b) => b.id === "author-card");
  const categories = BUILTIN_BLOCKS.find((b) => b.id === "categories");
  // A main-only block (regions: ["main"]) — never sidebar-placeable.
  const featured = BUILTIN_BLOCKS.find((b) => b.id === "featured-posts");
  assert.ok(authorCard && categories && featured, "fixtures present in builtin catalog");
  assert.deepEqual(authorCard.placement.regions, ["sidebar"]);
  assert.deepEqual(featured.placement.regions, ["main"]);

  // Placeable: sidebar blocks in the listing sidebar zone.
  assert.equal(placementAllows(authorCard, "sidebar", LISTING_REGION_MAP), true);
  assert.equal(placementAllows(categories, "sidebar", LISTING_REGION_MAP), true);
  // Not placeable: a main-only block in the (only) sidebar zone.
  assert.equal(placementAllows(featured, "sidebar", LISTING_REGION_MAP), false);
  assert.equal(placementAllows(undefined, "sidebar", LISTING_REGION_MAP), false);

  // Guard the regionMap value directly so a future revert to "complementary"
  // is caught even if the catalog changes.
  assert.equal(LISTING_REGION_MAP.sidebar, "sidebar");
});

test("groupAvailableBlocks: listing editor sidebar zone offers ≥1 placeable collection block (not an empty picker)", () => {
  // Integration-level: the listing editor's available-blocks for the sidebar
  // zone must be non-empty. Mirrors the controller's call (surfaceFilter from
  // the collection surface) + the placementAllows gate using the listing
  // regionMap, against the REAL builtin catalog.
  const names = new Set();
  const groups = groupAvailableBlocks(BUILTIN_BLOCKS, names, { surfaceFilter: "collection" });
  const placeable = groups
    .flatMap((g) => g.blocks)
    .filter((b) => placementAllows(
      BUILTIN_BLOCKS.find((e) => e.id === b.id),
      "sidebar",
      listingZoneModel.regionMap,
    ));
  assert.ok(placeable.length >= 1, "listing sidebar zone must offer at least one placeable block");
  // author-card and categories are both collection+sidebar — expect them.
  const ids = placeable.map((b) => b.id);
  assert.ok(ids.includes("author-card"), "author-card should be sidebar-placeable for collection");
  assert.ok(ids.includes("categories"), "categories should be sidebar-placeable for collection");
});

test("groupAvailableBlocks honors the injected surfaceFilter (homepage vs collection)", () => {
  // A fixture catalog with surface-specific blocks: one homepage-only, one
  // collection-only, one unrestricted (no surfaces ⇒ offered everywhere).
  const catalog = [
    { id: "hp-only", label: "HP", placement: { regions: ["main"], surfaces: ["homepage"] } },
    { id: "col-only", label: "Col", placement: { regions: ["main"], surfaces: ["collection"] } },
    { id: "anywhere", label: "Any", placement: { regions: ["main"] } },
  ];
  const idsIn = (groups) => groups.flatMap((g) => g.blocks.map((b) => b.id)).sort();
  const names = new Set();
  assert.deepEqual(
    idsIn(groupAvailableBlocks(catalog, names, { surfaceFilter: "homepage" })),
    ["anywhere", "hp-only"],
  );
  assert.deepEqual(
    idsIn(groupAvailableBlocks(catalog, names, { surfaceFilter: "collection" })),
    ["anywhere", "col-only"],
  );
});

test("groupAvailableBlocks with NO surfaceFilter applies no surface gate (restricted blocks still offered)", () => {
  // A missing surfaceFilter must NOT silently drop surface-restricted blocks —
  // every entry is offered.
  const catalog = [
    { id: "hp-only", label: "HP", placement: { regions: ["main"], surfaces: ["homepage"] } },
    { id: "col-only", label: "Col", placement: { regions: ["main"], surfaces: ["collection"] } },
    { id: "anywhere", label: "Any", placement: { regions: ["main"] } },
  ];
  const idsIn = (groups) => groups.flatMap((g) => g.blocks.map((b) => b.id)).sort();
  assert.deepEqual(
    idsIn(groupAvailableBlocks(catalog, new Set(), {})),
    ["anywhere", "col-only", "hp-only"],
  );
});

// ---- availableRegions exclusion + constraint (6.3 #29) ----
//
// A block is placeable on a surface iff its placement.regions intersect the
// surface's AVAILABLE REGIONS (= the values of its zone-model's regionMap).
// groupAvailableBlocks must (1) EXCLUDE blocks with an empty intersection and
// (2) CONSTRAIN each offered block's regions to that intersection, so the
// view's Zone dropdown only ever offers the surface's actual zones.

const homepageRegions = () => Object.values(homepageZoneModel.regionMap); // [hero,main,sidebar,footer]
const listingRegions = () => Object.values(listingZoneModel.regionMap); // [sidebar]

test("groupAvailableBlocks (LISTING regions [sidebar]): excludes Featured Posts (main-only), constrains sidebar blocks to ['sidebar'] (6.3 #29)", () => {
  const groups = groupAvailableBlocks(BUILTIN_BLOCKS, new Set(), {
    surfaceFilter: "collection",
    availableRegions: listingRegions(),
  });
  const blocks = groups.flatMap((g) => g.blocks);
  const byId = new Map(blocks.map((b) => [b.id, b]));

  // Featured Posts passes the surfaceFilter (surfaces incl. "collection") but
  // its only region is "main" — no sidebar placement, so it must NOT be listed.
  assert.equal(byId.has("featured-posts"), false, "Featured Posts (main-only) must be excluded from the listing picker");

  // The five sidebar-capable collection blocks ARE offered, each constrained to
  // exactly ["sidebar"] (no phantom "main"/"footer" zone option).
  for (const id of ["author-card", "categories", "recent-posts", "search", "custom-html"]) {
    const b = byId.get(id);
    assert.ok(b, `${id} should be offered on the listing surface`);
    assert.deepEqual(b.regions, ["sidebar"], `${id} regions must be constrained to ['sidebar']`);
  }
});

test("groupAvailableBlocks (HOMEPAGE regions [hero,main,sidebar,footer]): byte-identical to current — Featured Posts present with ['main'] (6.3 #29)", () => {
  const withRegions = groupAvailableBlocks(BUILTIN_BLOCKS, new Set(), {
    surfaceFilter: "homepage",
    availableRegions: homepageRegions(),
  });
  // The intersection with all four regions is the block's own regions, so the
  // grouped output must equal the pre-fix call (no availableRegions) exactly.
  const current = groupAvailableBlocks(BUILTIN_BLOCKS, new Set(), { surfaceFilter: "homepage" });
  assert.deepEqual(withRegions, current, "homepage availableBlocks must be unchanged by availableRegions");

  const byId = new Map(withRegions.flatMap((g) => g.blocks).map((b) => [b.id, b]));
  const featured = byId.get("featured-posts");
  assert.ok(featured, "Featured Posts must still be offered on homepage");
  assert.deepEqual(featured.regions, ["main"], "Featured Posts keeps its ['main'] region on homepage");
  // recent-posts keeps BOTH of its regions on homepage.
  assert.deepEqual(byId.get("recent-posts").regions, ["main", "sidebar"]);
});

test("groupAvailableBlocks: an ABSENT availableRegions applies no region gate (back-compat)", () => {
  // Callers that don't pass availableRegions (and existing tests) must see the
  // block's full regions, no exclusion.
  const catalog = [
    { id: "main-only", label: "M", placement: { regions: ["main"], surfaces: ["collection"] } },
  ];
  const groups = groupAvailableBlocks(catalog, new Set(), { surfaceFilter: "collection" });
  const blocks = groups.flatMap((g) => g.blocks);
  assert.equal(blocks.length, 1, "main-only block still offered when no availableRegions gate");
  assert.deepEqual(blocks[0].regions, ["main"]);
});

test("groupAvailableBlocks: availableRegions intersection composes with the stack sidebar-drop", () => {
  // Under arrangement==="stack" the sidebar zone is hidden, so a sidebar-only
  // block has an empty region set after the drop and must be excluded; a block
  // with both main+sidebar keeps only main. availableRegions = all four.
  const catalog = [
    { id: "both", label: "B", placement: { regions: ["main", "sidebar"], surfaces: ["homepage"] } },
    { id: "side-only", label: "S", placement: { regions: ["sidebar"], surfaces: ["homepage"] } },
  ];
  const groups = groupAvailableBlocks(catalog, new Set(), {
    surfaceFilter: "homepage",
    availableRegions: homepageRegions(),
    arrangement: "stack",
  });
  const byId = new Map(groups.flatMap((g) => g.blocks).map((b) => [b.id, b]));
  assert.deepEqual(byId.get("both").regions, ["main"], "stack drops sidebar from a main+sidebar block");
  assert.equal(byId.has("side-only"), false, "a sidebar-only block has no placeable zone under stack");
});

// A mock alternate zone-model: NOT homepage's vocabulary. `featured` is a
// single slot (node | null, like homepage's hero); `main` is a list zone.
// This proves the zone helpers derive their slots from the model and don't
// crash on a surface whose zones differ from homepage's four.
const ALT_MODEL = {
  zoneModel: true,
  zones: ["main", "featured"],
  regionMap: { main: "main", featured: "hero" },
};

test("decorateZones/typePresent/findNode generalize to an alternate zone-model", () => {
  const altZones = {
    arrangement: "stack",
    main: [section("a1", "recent-posts", { maxItems: 3 }), section("a2", "custom-html", {})],
    featured: section("f1", "hero", { showSocial: true }),
  };
  const blocks = decorateZones(altZones, CATALOG, new Set(), "simple", ALT_MODEL);
  // result is keyed by the MODEL's zones, not hardcoded hero/main/sidebar/footer
  assert.deepEqual(Object.keys(blocks).sort(), ["featured", "main"]);
  // list zone → array of cards; single slot → a single card object
  assert.equal(Array.isArray(blocks.main), true);
  assert.equal(blocks.main.length, 2);
  assert.equal(blocks.main[0].type, "recent-posts");
  assert.equal(Array.isArray(blocks.featured), false);
  assert.equal(blocks.featured.type, "hero");
  // hero block's legalZones derive from the model's regionMap: hero fits the
  // "featured" region (mapped to "hero"); it's already there, so it's excluded.
  assert.deepEqual(blocks.featured.legalZones, []);

  // typePresent flattens list + single slots across the model's zones
  assert.equal(typePresent(altZones, "hero", ALT_MODEL), true);
  assert.equal(typePresent(altZones, "recent-posts", ALT_MODEL), true);
  assert.equal(typePresent(altZones, "missing", ALT_MODEL), false);

  // findNode searches list zones AND single slots
  assert.equal(findNode(altZones, "a2", ALT_MODEL).type, "custom-html");
  assert.equal(findNode(altZones, "f1", ALT_MODEL).type, "hero");
  assert.equal(findNode(altZones, "nope", ALT_MODEL), null);
});

test("decorateZones renders an empty single slot as null (alternate model)", () => {
  const altZones = { arrangement: "stack", main: [], featured: null };
  const blocks = decorateZones(altZones, CATALOG, new Set(), "simple", ALT_MODEL);
  assert.deepEqual(blocks.main, []);
  assert.equal(blocks.featured, null);
});

test("undo payload round-trips; oversized/garbage tokens → null", () => {
  const removed = { node: section("b_x", "recent-posts", { maxItems: 5 }), zone: "main", index: 1 };
  const token = encodeUndoPayload(removed);
  assert.deepEqual(parseUndoPayload(token, HP_ZONES), removed);
  assert.equal(parseUndoPayload("!!!not-base64-json", HP_ZONES), null);
  assert.equal(parseUndoPayload("A".repeat(5000), HP_ZONES), null);
  assert.equal(parseUndoPayload(undefined, HP_ZONES), null);
  // container nodes and bad zones are rejected at parse time
  const container = encodeUndoPayload({ node: { block: "container", id: "c_x" }, zone: "main", index: 0 });
  assert.equal(parseUndoPayload(container, HP_ZONES), null);
  const badZone = encodeUndoPayload({ node: section("b_x", "t"), zone: "attic", index: 0 });
  assert.equal(parseUndoPayload(badZone, HP_ZONES), null);
});

test("parseUndoPayload structurally rejects non-object configs (schema-gate leniency bypass)", () => {
  // validateConfigAgainstSchema treats non-object configs as empty with
  // ok:true — this structural gate is what actually stops them (HIGH-1).
  for (const config of ["evil", 42, true, ["evil"], null]) {
    const token = encodeUndoPayload({
      node: { block: "section", id: "b_x", type: "recent-posts", v: 0, config },
      zone: "main", index: 0,
    });
    assert.equal(parseUndoPayload(token, HP_ZONES), null, JSON.stringify(config));
  }
  // ABSENT config is fine (the handler rebuilds with {})
  const absent = encodeUndoPayload({
    node: { block: "section", id: "b_x", type: "recent-posts", v: 0 },
    zone: "main", index: 0,
  });
  assert.ok(parseUndoPayload(absent, HP_ZONES));
});

test("encodeUndoPayload returns null when the payload exceeds 4096 chars", () => {
  const huge = { node: section("b_x", "custom-html", { content: "y".repeat(10000) }), zone: "main", index: 0 };
  assert.equal(encodeUndoPayload(huge), null);
});

test("readFlash surfaces query flags as success/error vars", () => {
  assert.equal(readFlash({ added: "1" }).success, "added");
  assert.equal(readFlash({ error: "placement" }).error, "placement");
  const removed = readFlash({ removed: "Experience", noUndo: "1" });
  assert.equal(removed.success, "removed");
  assert.equal(removed.removedLabel, "Experience");
  assert.equal(removed.undoUnavailable, true);
  // the arrangement redirect's sidebarMoved count rides along server-side
  // (admin templates have no `request` — the view reads the local)
  const arranged = readFlash({ arranged: "1", sidebarMoved: "2" });
  assert.equal(arranged.success, "arranged");
  assert.equal(arranged.sidebarMoved, "2");
  assert.deepEqual(readFlash({}), {});
});

// ---- hub ----

test("GET / renders the hub with homepage + listing + posttype live, pages disabled (6.4-T2)", async () => {
  const ik = makeIndiekit({
    compositions: [
      homepageDoc({ draftTree: baseTree(), draftUpdatedAt: "D" }),
      {
        ...sidebarDoc(),
        draftTree: sidebarDoc().tree,
        updatedAt: "2026-06-02T00:00:00.000Z",
      },
      {
        ...posttypeDoc(),
        draftTree: posttypeDoc().tree,
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    ],
  });
  const res = await callRoute(makeRouter(ik), "get", "/");
  assert.equal(res.rendered.view, "site-config-design");
  assert.equal(res.rendered.locals.activeTab, "design");
  const { surfaces } = res.rendered.locals;
  assert.equal(surfaces.length, 4);
  // Order: homepage, listing, posttype (all enabled), then pages (disabled).
  assert.deepEqual(surfaces[0], {
    key: "homepage", href: "/site-config/design/homepage", enabled: true,
    exists: true, hasDraft: true, updatedAt: "2026-06-01T00:00:00.000Z",
  });
  assert.deepEqual(surfaces[1], {
    key: "listing", href: "/site-config/design/listing", enabled: true,
    exists: true, hasDraft: true, updatedAt: "2026-06-02T00:00:00.000Z",
  });
  // posttype enabled, lowercase route + hub key (the casing trap).
  assert.deepEqual(surfaces[2], {
    key: "posttype", href: "/site-config/design/posttype", enabled: true,
    exists: true, hasDraft: true, updatedAt: "2026-06-03T00:00:00.000Z",
  });
  assert.deepEqual(surfaces[3], { key: "pages", enabled: false });
});

test("GET / hub: no composition → homepage exists false, hasDraft false", async () => {
  const res = await callRoute(makeRouter(makeIndiekit({ compositions: [] })), "get", "/");
  const [homepage] = res.rendered.locals.surfaces;
  assert.equal(homepage.exists, false);
  assert.equal(homepage.hasDraft, false);
});

test("GET / hub: listing with no composition → enabled card, exists false, hasDraft false", async () => {
  // homepage present, listing absent → listing still enabled (registered) but
  // reports no composition.
  const ik = makeIndiekit({ compositions: [homepageDoc()] });
  const res = await callRoute(makeRouter(ik), "get", "/");
  const listing = res.rendered.locals.surfaces.find((s) => s.key === "listing");
  assert.equal(listing.enabled, true);
  assert.equal(listing.exists, false);
  assert.equal(listing.hasDraft, false);
});

// ---- surface resolver (6.2) ----

test("resolveSurface 404s an unknown surface route", async () => {
  const res = await callRoute(makeRouter(makeIndiekit()), "get", "/bogus");
  assert.equal(res.statusCode, 404);
  assert.equal(res.body, "Unknown design surface");
});

test("the not-yet-live placeholder surface (pages) 404s on the editor; posttype is now live (6.4-T2)", async () => {
  const router = makeRouter(makeIndiekit());
  // pages is still a placeholder.
  const pages = await callRoute(router, "get", "/pages");
  assert.equal(pages.statusCode, 404, "pages");
  // posttype is registered in 6.4-T2 — its editor resolves (200, no crash).
  const ik = makeIndiekit({ compositions: [posttypeDoc()] });
  const posttype = await callRoute(makeRouter(ik), "get", "/posttype");
  assert.equal(posttype.statusCode, 200, "posttype");
  assert.equal(posttype.rendered.view, "site-config-design-homepage");
  assert.equal(posttype.rendered.locals.supportsArrangement, false);
});

test("GET /listing resolves (200, no crash) now that the listing surface is registered", async () => {
  // Uses the REAL registry (no resolveSurfaceEntry seam) — the listing entry
  // is live in 6.3-T3. The shared homepage view renders until T4 parameterizes
  // it; this test only asserts the route resolves and renders without crashing.
  const ik = makeIndiekit({ compositions: [sidebarDoc()] });
  const res = await callRoute(makeRouter(ik), "get", "/listing");
  assert.equal(res.statusCode, 200);
  assert.equal(res.rendered.view, "site-config-design-homepage");
  assert.equal(res.rendered.locals.supportsArrangement, false);
});

test("POST /listing/apply-recipe 404s (empty recipes / null treeBuilder) without invoking treeBuilder", async () => {
  // listing has recipes:[] and treeBuilder:null. The guard must 404 on the
  // empty recipes BEFORE reaching treeBuilder (which is null → would throw).
  const ik = makeIndiekit({ compositions: [sidebarDoc()] });
  const res = await callRoute(makeRouter(ik), "post", "/listing/apply-recipe", { recipeId: "blog" });
  assert.equal(res.statusCode, 404);
  // The handler body never ran past the guard: no draft written.
  assert.equal("draftTree" in ik._db.stores.compositions.get("collection:default"), false);
});

test("a POST to an unknown surface 404s before any handler runs", async () => {
  const ik = makeIndiekit();
  const res = await callRoute(makeRouter(ik), "post", "/bogus/blocks/add",
    { zone: "main", type: "cv-experience" });
  assert.equal(res.statusCode, 404);
  // no draft was written — the resolver short-circuits
  assert.equal("draftTree" in ik._db.stores.compositions.get("homepage"), false);
});

test("/mode and /api/build-status are NOT shadowed by the :surface param route", async () => {
  // /mode is a top-level POST (site-wide designMode); were it shadowed by
  // /:surface it would resolve surface="mode" → 404.
  const ik = makeIndiekit();
  const router = makeRouter(ik);
  const mode = await callRoute(router, "post", "/mode", { mode: "advanced" });
  assert.equal(mode.redirected.url, "/site-config/design/homepage");
  assert.equal(ik._db.stores.siteConfig.get("primary").designMode, "advanced");
  // /api/build-status is a top-level GET; surface="api" would 404 it.
  const status = await callRoute(
    makeRouter(makeIndiekit(), { readStatus: async () => null }),
    "get",
    "/api/build-status",
  );
  assert.deepEqual(status.jsonBody, { state: "unknown", stuck: false });
});

// ---- editor GET ----

test("GET /homepage with no composition → noComposition state with recipes", async () => {
  const res = await callRoute(makeRouter(makeIndiekit({ compositions: [] })), "get", "/homepage");
  assert.equal(res.rendered.view, "site-config-design-homepage");
  assert.equal(res.rendered.locals.noComposition, true);
  assert.equal(res.rendered.locals.recipes, LAYOUT_PRESETS);
  assert.equal(res.rendered.locals.zones, undefined);
});

test("GET /homepage renders zones, decorated blocks, grouped availableBlocks, mode, draft state", async () => {
  const ik = makeIndiekit();
  const res = await callRoute(makeRouter(ik), "get", "/homepage");
  const { locals } = res.rendered;
  assert.equal(locals.activeTab, "design");
  assert.equal(locals.mode, "simple"); // no designMode in siteConfig → default
  assert.equal(locals.isDraft, false);
  assert.equal(locals.draftUpdatedAt, null);
  assert.equal(locals.zones.arrangement, "sidebar-right");
  // decorated cards carry catalog metadata + form fields
  assert.equal(locals.blocks.hero.label, "Hero Section");
  assert.equal(locals.blocks.main[0].type, "recent-posts");
  assert.ok(locals.blocks.main[0].fields.some((f) => f.name === "maxItems"));
  // D4 card additions: source badge + move-to targets (current zone excluded)
  assert.equal(locals.blocks.main[0].sourcePlugin, null); // built-in
  assert.deepEqual(locals.blocks.main[0].legalZones, ["sidebar"]); // recent-posts: main+sidebar
  assert.deepEqual(locals.blocks.main[1].legalZones, ["sidebar", "footer"]); // custom-html
  assert.deepEqual(locals.blocks.hero.legalZones, []); // hero block fits the hero zone only
  assert.equal(typeof locals.blocks.main[0].category, "string");
  // availableBlocks: built-in group first, plugin groups after, dormant flagged
  const groups = Object.fromEntries(locals.availableBlocks.map((g) => [g.group, g.blocks]));
  assert.equal(locals.availableBlocks[0].group, "built-in");
  assert.ok(groups["built-in"].some((b) => b.id === "hero"));
  assert.equal(groups["CV endpoint"].find((b) => b.id === "cv-experience").dormant, false);
  assert.equal(groups["Removed endpoint"].find((b) => b.id === "ghost-widget").dormant, true);
  assert.equal(locals.recipes, LAYOUT_PRESETS);
});

test("GET /homepage surfaces draft state and flash params", async () => {
  const ik = makeIndiekit({
    compositions: [homepageDoc({ draftTree: baseTree(), draftUpdatedAt: "2026-06-12T08:00:00.000Z" })],
  });
  const res = await callRoute(makeRouter(ik), "get", "/homepage?added=1");
  assert.equal(res.rendered.locals.isDraft, true);
  assert.equal(res.rendered.locals.draftUpdatedAt, "2026-06-12T08:00:00.000Z");
  assert.equal(res.rendered.locals.success, "added");
});

test("GET /homepage parses a valid ?u= undo payload and ignores garbage ones", async () => {
  const ik = makeIndiekit();
  const removed = { node: section("b_gone", "recent-posts", {}), zone: "main", index: 0 };
  const token = encodeUndoPayload(removed);
  const ok = await callRoute(makeRouter(ik), "get", `/homepage?removed=Recent+Posts&u=${token}`);
  assert.deepEqual(ok.rendered.locals.undo, { ...removed, token });
  assert.equal(ok.rendered.locals.removedLabel, "Recent Posts");
  const bad = await callRoute(makeRouter(ik), "get", "/homepage?u=garbage!!");
  assert.equal(bad.rendered.locals.undo, null);
});

test("GET /homepage custom tree → read-only customTree state", async () => {
  const ik = makeIndiekit({ compositions: [homepageDoc({ tree: customTree() })] });
  const res = await callRoute(makeRouter(ik), "get", "/homepage");
  assert.equal(res.rendered.locals.customTree, true);
  assert.equal(res.rendered.locals.zones, undefined);
});

test("GET /homepage with no database → 503", async () => {
  const ik = makeIndiekit();
  ik.database = null;
  const res = await callRoute(makeRouter(ik), "get", "/homepage");
  assert.equal(res.statusCode, 503);
});

// ---- add ----

test("POST add appends with the catalog defaultConfig and saves a draft", async () => {
  const ik = makeIndiekit();
  const res = await callRoute(makeRouter(ik), "post", "/homepage/blocks/add",
    { zone: "main", type: "cv-experience" });
  assert.equal(res.redirected.status, 303);
  assert.equal(flag(res, "added"), "1");
  const zones = draftZones(ik);
  const added = zones.main.at(-1);
  assert.equal(added.type, "cv-experience");
  assert.deepEqual(added.config, { maxItems: 3 }); // entry.defaultConfig
  assert.match(added.id, /^b_/);
  // published tree untouched
  assert.equal(treeToZones(ik._db.stores.compositions.get("homepage").tree).main.length, 2);
  // the plugin block's card carries its source plugin (D4 badge)
  const get = await callRoute(makeRouter(ik), "get", "/homepage");
  const card = get.rendered.locals.blocks.main.at(-1);
  assert.equal(card.sourcePlugin, "CV endpoint");
  assert.deepEqual(card.legalZones, []); // cv-experience: main only
});

test("POST add gate violations: zone name, unknown type, placement, multiple:false", async () => {
  const ik = makeIndiekit();
  const router = makeRouter(ik);
  const cases = [
    [{ zone: "attic", type: "recent-posts" }, "invalid-zone"],
    [{ zone: "main", type: "warp-drive" }, "unknown-type"],
    [{ zone: "footer", type: "recent-posts" }, "placement"], // recent-posts: main|sidebar only
    [{ zone: "hero", type: "recent-posts" }, "placement"],
    [{ zone: "main", type: "hero" }, "placement"], // hero block only fits the hero zone
  ];
  for (const [body, code] of cases) {
    const res = await callRoute(router, "post", "/homepage/blocks/add", body);
    assert.equal(flag(res, "error"), code, JSON.stringify(body));
  }
  // multiple:false — a hero already exists (in the hero slot)
  const dup = await callRoute(router, "post", "/homepage/blocks/add", { zone: "hero", type: "hero" });
  assert.equal(flag(dup, "error"), "duplicate");
  // none of the rejections saved a draft
  assert.equal("draftTree" in ik._db.stores.compositions.get("homepage"), false);
});

test("POSTs are rejected on a custom tree (read-only)", async () => {
  const ik = makeIndiekit({ compositions: [homepageDoc({ tree: customTree() })] });
  const res = await callRoute(makeRouter(ik), "post", "/homepage/blocks/add",
    { zone: "main", type: "cv-experience" });
  assert.equal(flag(res, "error"), "custom-tree");
});

test("POSTs are rejected when no composition exists", async () => {
  const ik = makeIndiekit({ compositions: [] });
  const res = await callRoute(makeRouter(ik), "post", "/homepage/blocks/add",
    { zone: "main", type: "cv-experience" });
  assert.equal(flag(res, "error"), "no-composition");
});

// ---- move ----

test("POST move-down/move-up reorder within the zone; edges are saved no-ops", async () => {
  const ik = makeIndiekit();
  const router = makeRouter(ik);
  const down = await callRoute(router, "post", "/homepage/blocks/b_m1/move-down");
  assert.equal(flag(down, "moved"), "1");
  assert.deepEqual(draftZones(ik).main.map((n) => n.id), ["b_m2", "b_m1"]);
  const up = await callRoute(router, "post", "/homepage/blocks/b_m1/move-up");
  assert.deepEqual(draftZones(ik).main.map((n) => n.id), ["b_m1", "b_m2"]);
  assert.equal(flag(up, "moved"), "1");
});

test("POST move-up unknown block → not-found", async () => {
  const res = await callRoute(makeRouter(makeIndiekit()), "post", "/homepage/blocks/b_nope/move-up");
  assert.equal(flag(res, "error"), "not-found");
});

test("POST move-to moves across zones when placement allows", async () => {
  const ik = makeIndiekit();
  const res = await callRoute(makeRouter(ik), "post", "/homepage/blocks/b_m1/move-to", { zone: "sidebar" });
  assert.equal(flag(res, "moved"), "1");
  const zones = draftZones(ik);
  assert.deepEqual(zones.main.map((n) => n.id), ["b_m2"]);
  assert.deepEqual(zones.sidebar.map((n) => n.id), ["b_s1", "b_m1"]);
});

test("POST move-to placement-blocked and invalid-zone paths", async () => {
  const ik = makeIndiekit();
  const router = makeRouter(ik);
  const blocked = await callRoute(router, "post", "/homepage/blocks/b_m1/move-to", { zone: "footer" });
  assert.equal(flag(blocked, "error"), "placement");
  const bad = await callRoute(router, "post", "/homepage/blocks/b_m1/move-to", { zone: "attic" });
  assert.equal(flag(bad, "error"), "invalid-zone");
  const missing = await callRoute(router, "post", "/homepage/blocks/b_nope/move-to", { zone: "sidebar" });
  assert.equal(flag(missing, "error"), "not-found");
});

test("POST move-to-index places at the clamped index (drag-end target)", async () => {
  const ik = makeIndiekit();
  const router = makeRouter(ik);
  const res = await callRoute(router, "post", "/homepage/blocks/b_s1/move-to-index",
    { zone: "main", index: "0" });
  assert.equal(flag(res, "moved"), "1");
  const zones = draftZones(ik);
  assert.deepEqual(zones.main.map((n) => n.id), ["b_s1", "b_m1", "b_m2"]);
  assert.deepEqual(zones.sidebar, []);
  // clamped + placement-gated + index validation
  const clamped = await callRoute(router, "post", "/homepage/blocks/b_m1/move-to-index",
    { zone: "sidebar", index: "99" });
  assert.equal(flag(clamped, "moved"), "1");
  assert.equal(draftZones(ik).sidebar.at(-1).id, "b_m1");
  const blocked = await callRoute(router, "post", "/homepage/blocks/b_m2/move-to-index",
    { zone: "hero", index: "0" });
  assert.equal(flag(blocked, "error"), "placement");
  const nan = await callRoute(router, "post", "/homepage/blocks/b_m2/move-to-index",
    { zone: "main", index: "first" });
  assert.equal(flag(nan, "error"), "invalid-index");
});

// ---- remove / restore ----

test("POST remove saves the draft and redirects with label + undo token", async () => {
  const ik = makeIndiekit();
  const res = await callRoute(makeRouter(ik), "post", "/homepage/blocks/b_m1/remove");
  assert.equal(res.redirected.status, 303);
  assert.equal(flag(res, "removed"), "Recent Posts"); // catalog label, not type
  const payload = parseUndoPayload(flag(res, "u"), HP_ZONES);
  assert.deepEqual(payload, { node: section("b_m1", "recent-posts", { maxItems: 10 }), zone: "main", index: 0 });
  assert.deepEqual(draftZones(ik).main.map((n) => n.id), ["b_m2"]);
});

test("POST remove not-found → flash error, no draft", async () => {
  const ik = makeIndiekit();
  const res = await callRoute(makeRouter(ik), "post", "/homepage/blocks/b_nope/remove");
  assert.equal(flag(res, "error"), "not-found");
  assert.equal("draftTree" in ik._db.stores.compositions.get("homepage"), false);
});

test("remove → restore round-trips the block to its zone and index", async () => {
  const ik = makeIndiekit();
  const router = makeRouter(ik);
  const removed = await callRoute(router, "post", "/homepage/blocks/b_m1/remove");
  const token = flag(removed, "u");
  const res = await callRoute(router, "post", "/homepage/blocks/restore", { u: token });
  assert.equal(flag(res, "restored"), "1");
  assert.deepEqual(draftZones(ik).main.map((n) => n.id), ["b_m1", "b_m2"]);
  assert.deepEqual(draftZones(ik).main[0].config, { maxItems: 10 });
});

test("POST restore rejects tampered payloads (schema-violating config) without saving", async () => {
  const ik = makeIndiekit();
  const tampered = encodeUndoPayload({
    node: section("b_evil", "recent-posts", { maxItems: 999 }), // maximum is 50
    zone: "main", index: 0,
  });
  const res = await callRoute(makeRouter(ik), "post", "/homepage/blocks/restore", { u: tampered });
  assert.equal(flag(res, "error"), "undo-invalid");
  assert.equal("draftTree" in ik._db.stores.compositions.get("homepage"), false);
});

test("POST restore rejects unknown types, illegal zones, duplicate ids, garbage tokens", async () => {
  const ik = makeIndiekit();
  const router = makeRouter(ik);
  const cases = [
    [encodeUndoPayload({ node: section("b_x", "warp-drive"), zone: "main", index: 0 }), "unknown-type"],
    [encodeUndoPayload({ node: section("b_x", "recent-posts"), zone: "footer", index: 0 }), "placement"],
    [encodeUndoPayload({ node: section("b_m2", "custom-html"), zone: "main", index: 0 }), "duplicate"], // id already in tree
    ["%%%garbage", "undo-invalid"],
  ];
  for (const [token, code] of cases) {
    const res = await callRoute(router, "post", "/homepage/blocks/restore", { u: token });
    assert.equal(flag(res, "error"), code, String(code));
  }
});

test("POST restore rejects a string config (raw value must never reach draft or artifact)", async () => {
  const ik = makeIndiekit();
  const tampered = encodeUndoPayload({
    node: { block: "section", id: "b_evil", type: "recent-posts", v: 0, config: "evil" },
    zone: "main", index: 0,
  });
  const res = await callRoute(makeRouter(ik), "post", "/homepage/blocks/restore", { u: tampered });
  assert.equal(flag(res, "error"), "undo-invalid");
  assert.equal("draftTree" in ik._db.stores.compositions.get("homepage"), false);
});

test("POST restore clamps v to the catalog version (never the payload's)", async () => {
  const ik = makeIndiekit();
  const forged = encodeUndoPayload({
    node: { ...section("b_new", "recent-posts", { maxItems: 5 }), v: 99 },
    zone: "main", index: 0,
  });
  const res = await callRoute(makeRouter(ik), "post", "/homepage/blocks/restore", { u: forged });
  assert.equal(flag(res, "restored"), "1");
  const restored = draftZones(ik).main[0];
  assert.equal(restored.id, "b_new");
  assert.equal(restored.v, 1); // recent-posts catalog entry version, not 99
});

test("POST restore strips extra keys from the restored node (tamper-safe rebuild)", async () => {
  const ik = makeIndiekit();
  const sneaky = encodeUndoPayload({
    node: { ...section("b_new", "cv-experience", { maxItems: 3 }), backdoor: true },
    zone: "main", index: 1,
  });
  const res = await callRoute(makeRouter(ik), "post", "/homepage/blocks/restore", { u: sneaky });
  assert.equal(flag(res, "restored"), "1");
  const restored = draftZones(ik).main[1];
  assert.deepEqual(restored, section("b_new", "cv-experience", { maxItems: 3 }));
  assert.equal("backdoor" in restored, false);
});

// ---- config ----

test("POST config coerces + saves valid form bodies", async () => {
  const ik = makeIndiekit();
  const res = await callRoute(makeRouter(ik), "post", "/homepage/blocks/b_m1/config",
    { maxItems: "5", postTypes: "note, article" });
  assert.equal(flag(res, "saved"), "1");
  const node = draftZones(ik).main[0];
  assert.deepEqual(node.config, { maxItems: 5, postTypes: ["note", "article"] });
  assert.equal(node.id, "b_m1"); // id/type untouched
});

test("POST config sanitizes custom-html content at save time (stored-XSS control)", async () => {
  const ik = makeIndiekit();
  const res = await callRoute(makeRouter(ik), "post", "/homepage/blocks/b_m2/config",
    { title: "Hi", content: "<p>ok</p><script>alert(1)</script>" });
  assert.equal(flag(res, "saved"), "1");
  const node = draftZones(ik).main[1]; // b_m2 is the custom-html block
  assert.equal(node.config.content.includes("<script"), false);
  assert.ok(node.config.content.includes("<p>ok</p>"));
  assert.equal(node.config.title, "Hi"); // non-content fields untouched
});

test("POST restore sanitizes custom-html content in the undo payload", async () => {
  const ik = makeIndiekit();
  const token = encodeUndoPayload({
    node: section("b_new", "custom-html", { content: "<p>ok</p><script>alert(1)</script>" }),
    zone: "main", index: 0,
  });
  const res = await callRoute(makeRouter(ik), "post", "/homepage/blocks/restore", { u: token });
  assert.equal(flag(res, "restored"), "1");
  const restored = draftZones(ik).main[0];
  assert.equal(restored.config.content.includes("<script"), false);
  assert.ok(restored.config.content.includes("<p>ok</p>"));
});

test("POST config invalid → 200 re-render with fieldErrors + openBlockId, no save", async () => {
  const ik = makeIndiekit();
  const res = await callRoute(makeRouter(ik), "post", "/homepage/blocks/b_m1/config",
    { maxItems: "lots", postTypes: "note, article" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.rendered.view, "site-config-design-homepage");
  assert.equal(res.rendered.locals.openBlockId, "b_m1");
  assert.ok(res.rendered.locals.fieldErrors.some((e) => /maxItems/.test(e)));
  assert.ok(res.rendered.locals.zones); // full editor locals so the page re-renders whole
  // the coerced submitted values ride along so the form re-fills as typed
  assert.deepEqual(res.rendered.locals.submittedConfig, { postTypes: ["note", "article"] });
  assert.equal("draftTree" in ik._db.stores.compositions.get("homepage"), false);
});

test("POST config unknown block → not-found", async () => {
  const res = await callRoute(makeRouter(makeIndiekit()), "post", "/homepage/blocks/b_nope/config", {});
  assert.equal(flag(res, "error"), "not-found");
});

// ---- arrangement ----

test("POST arrangement sidebar-right→stack moves sidebar blocks to main (never drops)", async () => {
  const ik = makeIndiekit();
  const res = await callRoute(makeRouter(ik), "post", "/homepage/arrangement", { arrangement: "stack" });
  assert.equal(flag(res, "arranged"), "1");
  assert.equal(flag(res, "sidebarMoved"), "1"); // flash notice carries the count
  const zones = draftZones(ik);
  assert.equal(zones.arrangement, "stack");
  assert.deepEqual(zones.main.map((n) => n.id), ["b_m1", "b_m2", "b_s1"]);
  assert.deepEqual(zones.sidebar, []);
});

test("GET after the arrangement redirect carries sidebarMoved in the locals", async () => {
  const ik = makeIndiekit();
  const router = makeRouter(ik);
  const res = await callRoute(router, "post", "/homepage/arrangement", { arrangement: "stack" });
  const redirected = new URL(res.redirected.url, "http://x");
  const get = await callRoute(router, "get", `/homepage${redirected.search}`);
  assert.equal(get.rendered.locals.success, "arranged");
  assert.equal(get.rendered.locals.sidebarMoved, "1");
});

test("stack arrangement hides the sidebar zone everywhere: add gated, legalZones and picker regions filtered", async () => {
  const ik = makeIndiekit();
  const router = makeRouter(ik);
  await callRoute(router, "post", "/homepage/arrangement", { arrangement: "stack" });
  // add into the hidden sidebar zone → invalid-zone flash, draft unchanged
  const mainCount = draftZones(ik).main.length;
  const add = await callRoute(router, "post", "/homepage/blocks/add",
    { zone: "sidebar", type: "recent-posts" });
  assert.equal(flag(add, "error"), "invalid-zone");
  assert.equal(draftZones(ik).main.length, mainCount);
  // sidebar never offered as a move-to target or picker zone under stack
  const get = await callRoute(router, "get", "/homepage");
  const { locals } = get.rendered;
  assert.deepEqual(locals.blocks.main[0].legalZones, []); // recent-posts: main+sidebar → sidebar filtered
  assert.deepEqual(locals.blocks.main[1].legalZones, ["footer"]); // custom-html keeps footer only
  const groups = Object.fromEntries(locals.availableBlocks.map((g) => [g.group, g.blocks]));
  // 6.3 #29: a sidebar-only block has no placeable zone under "stack" (sidebar
  // hidden) → EXCLUDED from the picker entirely. Its whole group (only
  // ghost-widget) drops out. (Pre-fix it was offered with regions:[]; the view
  // already skipped empty-region entries, so the rendered picker is unchanged.)
  assert.equal("Removed endpoint" in groups, false, "sidebar-only block's group is excluded under stack");
  const recent = groups["built-in"].find((b) => b.id === "recent-posts");
  assert.deepEqual(recent.regions, ["main"]);
});

test("stack arrangement gates move-to into the hidden sidebar zone", async () => {
  const ik = makeIndiekit();
  const router = makeRouter(ik);
  await callRoute(router, "post", "/homepage/arrangement", { arrangement: "stack" });
  const mainIds = draftZones(ik).main.map((n) => n.id);
  const res = await callRoute(router, "post", "/homepage/blocks/b_m1/move-to", { zone: "sidebar" });
  assert.equal(flag(res, "error"), "invalid-zone");
  assert.deepEqual(draftZones(ik).main.map((n) => n.id), mainIds); // draft unchanged
  assert.deepEqual(draftZones(ik).sidebar, []);
});

test("stack arrangement gates move-to-index into the hidden sidebar zone", async () => {
  const ik = makeIndiekit();
  const router = makeRouter(ik);
  await callRoute(router, "post", "/homepage/arrangement", { arrangement: "stack" });
  const mainIds = draftZones(ik).main.map((n) => n.id);
  const res = await callRoute(router, "post", "/homepage/blocks/b_m1/move-to-index",
    { zone: "sidebar", index: "0" });
  assert.equal(flag(res, "error"), "invalid-zone");
  assert.deepEqual(draftZones(ik).main.map((n) => n.id), mainIds);
  assert.deepEqual(draftZones(ik).sidebar, []);
});

test("stack arrangement gates restore into the hidden sidebar zone (undo across an arrangement switch)", async () => {
  const ik = makeIndiekit();
  const router = makeRouter(ik);
  // Remove a sidebar block while sidebar-right, THEN switch to stack — the
  // undo token still targets the (now hidden) sidebar zone.
  const removed = await callRoute(router, "post", "/homepage/blocks/b_s1/remove");
  const token = flag(removed, "u");
  await callRoute(router, "post", "/homepage/arrangement", { arrangement: "stack" });
  const res = await callRoute(router, "post", "/homepage/blocks/restore", { u: token });
  assert.equal(flag(res, "error"), "invalid-zone");
  assert.deepEqual(draftZones(ik).sidebar, []); // nothing restored into the hidden zone
});

test("POST arrangement stack→sidebar-right and invalid values", async () => {
  const ik = makeIndiekit();
  const router = makeRouter(ik);
  await callRoute(router, "post", "/homepage/arrangement", { arrangement: "stack" });
  const back = await callRoute(router, "post", "/homepage/arrangement", { arrangement: "sidebar-right" });
  assert.equal(flag(back, "arranged"), "1");
  assert.equal(flag(back, "sidebarMoved"), null);
  assert.equal(draftZones(ik).arrangement, "sidebar-right");
  const bad = await callRoute(router, "post", "/homepage/arrangement", { arrangement: "diagonal" });
  assert.equal(flag(bad, "error"), "invalid-arrangement");
});

// ---- arrangement capability gate (6.3-T2) ----
//
// The /arrangement route is homepage-shaped: it spreads `zones.main` when
// collapsing the sidebar. A sidebar-only surface (the 6.3 listing surface)
// has NO `main` zone — reaching that body would throw. The gate must 404 on
// `!surface.arrangements` BEFORE any zone access.
//
// The listing surface isn't registered until 6.3-T3, so we exercise the gate
// through designRouter's `resolveSurfaceEntry` seam: a real, off-registry
// surface entry that OMITS `arrangements` and uses the sidebar-only
// listingZoneModel. Its composition has a populated sidebar so that — were the
// gate absent — the handler would actually reach (and crash on) the missing
// `main` zone, not bail earlier.

// A recognized sidebar-only composition (root stack → one sticky complementary
// stack → sections). zones from this tree have `sidebar` but no `main`.
const sidebarDoc = () => ({
  _id: "collection:default", schemaVersion: 4, kind: "collection", status: "published",
  tree: {
    block: "container", id: "c_root", as: "stack", role: "root",
    children: [
      {
        block: "container", id: "c_side", as: "stack", role: "complementary",
        variant: { sticky: true },
        children: [section("b_s1", "recent-posts", { maxItems: 5 })],
      },
    ],
  },
  updatedAt: "2026-06-01T00:00:00.000Z", updatedBy: "test",
});

// The postType (post sidebar) surface composition (6.4): same sidebar-only
// shape as sidebarDoc, but _id "posttype:default" + kind "postType".
const posttypeDoc = () => ({
  _id: "posttype:default", schemaVersion: 4, kind: "postType", status: "published",
  tree: {
    block: "container", id: "c_root", as: "stack", role: "root",
    children: [
      {
        block: "container", id: "c_side", as: "stack", role: "complementary",
        variant: { sticky: true },
        children: [section("b_s1", "recent-posts", { maxItems: 5 })],
      },
    ],
  },
  updatedAt: "2026-06-01T00:00:00.000Z", updatedBy: "test",
});

// A surface entry with NO `arrangements` field, modeling the listing surface.
const NO_ARRANGEMENT_SURFACE = Object.freeze({
  routeKey: "listing",
  surfaceId: "collection:default",
  kind: "collection",
  surfaceFilter: "collection",
  editorView: "site-config-design-homepage",
  hubKey: "listing",
  zoneModel: listingZoneModel,
  recipes: [],
  treeBuilder: () => null,
  // arrangements intentionally omitted ⇒ no arrangement axis.
});

// Resolver seam: keeps the real registry for known keys, adds `listing`.
const withListing = (key) =>
  key === "listing" ? NO_ARRANGEMENT_SURFACE : getSurface(key);

test("POST /listing/arrangement 404s on a no-arrangement surface (no zones.main crash)", async () => {
  const ik = makeIndiekit({ compositions: [sidebarDoc()] });
  const router = makeRouter(ik, { resolveSurfaceEntry: withListing });
  // `stack` would, on homepage, spread `zones.main` — a sidebar-only surface
  // has none, so reaching the body would throw. The gate must 404 first.
  const res = await callRoute(router, "post", "/listing/arrangement", { arrangement: "stack" });
  assert.equal(res.statusCode, 404);
  // The handler body never ran: no draft was written to the composition doc.
  assert.equal("draftTree" in ik._db.stores.compositions.get("collection:default"), false);
});

test("GET /homepage exposes supportsArrangement:true (view renders the arrangement form)", async () => {
  const res = await callRoute(makeRouter(makeIndiekit()), "get", "/homepage");
  assert.equal(res.rendered.locals.supportsArrangement, true);
});

test("GET /listing exposes supportsArrangement:false (no arrangement form for a sidebar-only surface)", async () => {
  const ik = makeIndiekit({ compositions: [sidebarDoc()] });
  const router = makeRouter(ik, { resolveSurfaceEntry: withListing });
  const res = await callRoute(router, "get", "/listing");
  assert.equal(res.rendered.locals.supportsArrangement, false);
});

test("POST /listing/arrangement 404s even for an otherwise-valid arrangement value", async () => {
  // Proves the gate keys on the surface capability, NOT on the value: a value
  // that would be valid on homepage ("sidebar-right") is still rejected here.
  const ik = makeIndiekit({ compositions: [sidebarDoc()] });
  const router = makeRouter(ik, { resolveSurfaceEntry: withListing });
  const res = await callRoute(router, "post", "/listing/arrangement", { arrangement: "sidebar-right" });
  assert.equal(res.statusCode, 404);
  assert.equal("draftTree" in ik._db.stores.compositions.get("collection:default"), false);
});

// ---- zoneNames local + shared-view parameterization (6.3-T4) ----
//
// The editor view (site-config-design-homepage.njk) is SHARED across surfaces.
// T4 drives the rendered zones from `zoneNames` (= surface.zoneModel.zones) so a
// sidebar-only surface renders just its sidebar editor — no empty hero/main/
// footer, no arrangement form. The locals tests below assert the controller
// exposes the right vocabulary; the render tests prove the view honors it.

test("GET /homepage exposes zoneNames = the homepage zone-model's four zones", async () => {
  const res = await callRoute(makeRouter(makeIndiekit()), "get", "/homepage");
  assert.deepEqual(res.rendered.locals.zoneNames, ["hero", "main", "sidebar", "footer"]);
});

test("GET /listing exposes zoneNames = ['sidebar'] (the listing zone-model)", async () => {
  const ik = makeIndiekit({ compositions: [sidebarDoc()] });
  const router = makeRouter(ik, { resolveSurfaceEntry: withListing });
  const res = await callRoute(router, "get", "/listing");
  assert.deepEqual(res.rendered.locals.zoneNames, ["sidebar"]);
});

// Render the SHARED view's `{% block content %}` body directly. We strip the
// `{% extends %}`/`{% from %}` lines and provide the imported macros as no-op
// globals, because the fork's modal-dialog/toggle-switch macros aren't in the
// installed @indiekit/frontend. This faithfully exercises the EXACT visibleZones
// build + zone loop T4 changed.
function renderEditorContent(locals) {
  const source = readFileSync(
    new URL("../views/site-config-design-homepage.njk", import.meta.url),
    "utf8",
  );
  const body = source
    .replace(/\{% extends [^%]+%\}/g, "")
    .replace(/\{% from [^%]+%\}/g, "")
    .replace(/\{% block content %\}/g, "")
    .replace(/\{% endblock %\}/g, "");
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader([
      "views",
      "views/partials",
      "node_modules/@indiekit/frontend/components",
      "node_modules/@indiekit/frontend",
    ]),
    { autoescape: true },
  );
  env.addGlobal("__", (k, o) => (o ? `${k}:${JSON.stringify(o)}` : k));
  env.addGlobal("icon", (n) => `<icon>${n || ""}</icon>`);
  for (const m of ["badge", "button", "details", "modalDialog", "notificationBanner", "toggleSwitch"]) {
    env.addGlobal(m, (...a) => `<${m}>${JSON.stringify(a)}</${m}>`);
  }
  env.addFilter("date", (v, f) => `[date:${v}:${f}]`);
  env.addFilter("truncate", (v, n) => String(v).slice(0, n));
  env.addFilter("round", (v) => Math.round(v));
  env.addFilter("dump", (v) => JSON.stringify(v));
  return env.renderString(body, locals);
}

const RENDER_BLOCKS = () => ({
  hero: { id: "b_hero", type: "hero", label: "Hero", icon: "home", config: {}, legalZones: [], fields: [] },
  main: [
    { id: "b_m1", type: "recent-posts", label: "Recent", icon: "list", config: { maxItems: 10 }, legalZones: ["sidebar"], fields: [] },
    { id: "b_m2", type: "custom-html", label: "Custom", icon: "code", config: {}, legalZones: ["sidebar", "footer"], fields: [] },
  ],
  sidebar: [{ id: "b_s1", type: "recent-posts", label: "Recent", icon: "list", config: { maxItems: 5 }, legalZones: ["main"], fields: [] }],
  footer: [],
});
const RENDER_AVAILABLE = () => [
  { group: "built-in", blocks: [
    { id: "hero", label: "Hero", icon: "home", description: "", regions: ["hero"], dormant: false },
    { id: "recent-posts", label: "Recent", icon: "list", description: "", regions: ["main", "sidebar"], dormant: false },
  ]},
];
const RENDER_BASE = {
  activeTab: "design", recipes: [{ id: "blog", label: "Blog", description: "d" }],
  mode: "advanced", isDraft: true, draftUpdatedAt: "2026-06-12T08:00:00.000Z",
  undo: null, pane: "structural", preview: { token: "t", revision: 1 }, previewing: null,
  // Per-surface copy keys (6.3 #28); the test __() mock echoes the key back.
  editorTitleKey: "siteConfig.design.editor.title",
  editorIntroKey: "siteConfig.design.editor.description",
};

test("editor view renders ALL homepage zones + arrangement form when zoneNames=4 and supportsArrangement", () => {
  const blocks = RENDER_BLOCKS();
  const html = renderEditorContent({
    ...RENDER_BASE, supportsArrangement: true, supportsLivePreview: true,
    surfaceBase: "/site-config/design/homepage",
    zoneNames: ["hero", "main", "sidebar", "footer"],
    zones: { arrangement: "sidebar-right", ...blocks },
    blocks, availableBlocks: RENDER_AVAILABLE(),
  });
  for (const zone of ["hero", "main", "sidebar", "footer"]) {
    assert.match(html, new RegExp(`data-sc-zone="${zone}"`), `homepage missing zone ${zone}`);
  }
  assert.match(html, /class="sc-arrangement"/, "homepage missing arrangement form");
});

test("editor view renders ONLY the sidebar zone (no hero/main/footer, no arrangement form) when zoneNames=['sidebar']", () => {
  const blocks = RENDER_BLOCKS();
  const html = renderEditorContent({
    ...RENDER_BASE, supportsArrangement: false, supportsLivePreview: false,
    surfaceBase: "/site-config/design/listing",
    zoneNames: ["sidebar"],
    zones: { sidebar: blocks.sidebar },
    blocks: { sidebar: blocks.sidebar }, availableBlocks: RENDER_AVAILABLE(),
  });
  assert.match(html, /data-sc-zone="sidebar"/, "listing missing sidebar zone");
  for (const zone of ["hero", "main", "footer"]) {
    assert.doesNotMatch(html, new RegExp(`data-sc-zone="${zone}"`), `listing must NOT render zone ${zone}`);
  }
  assert.doesNotMatch(html, /class="sc-arrangement"/, "listing must NOT render arrangement form");
});

// ---- live-preview pane gating (6.3 #31 stopgap) ----

test("editor view (supportsLivePreview=true) renders the preview pane + Structural/Preview toggle (homepage)", () => {
  const blocks = RENDER_BLOCKS();
  const html = renderEditorContent({
    ...RENDER_BASE, supportsArrangement: true, supportsLivePreview: true,
    surfaceBase: "/site-config/design/homepage",
    zoneNames: ["hero", "main", "sidebar", "footer"],
    zones: { arrangement: "sidebar-right", ...blocks },
    blocks, availableBlocks: RENDER_AVAILABLE(),
  });
  // Structural/Preview toggle nav + the structural preview pane are present;
  // the "unavailable" notice is NOT.
  assert.match(html, /class="sc-pane-toggle"/, "homepage missing the Structural/Preview toggle");
  assert.match(html, /sc-design__preview/, "homepage missing the preview pane");
  assert.doesNotMatch(html, /data-sc-preview-unavailable/, "homepage must NOT show the unavailable notice");
});

test("editor view (supportsLivePreview=false) renders NEITHER the preview pane NOR the toggle — shows a notice (listing)", () => {
  const blocks = RENDER_BLOCKS();
  const html = renderEditorContent({
    ...RENDER_BASE, supportsArrangement: false, supportsLivePreview: false,
    surfaceBase: "/site-config/design/listing",
    zoneNames: ["sidebar"],
    zones: { sidebar: blocks.sidebar },
    blocks: { sidebar: blocks.sidebar }, availableBlocks: RENDER_AVAILABLE(),
  });
  // No preview iframe, no Structural/Preview toggle.
  assert.doesNotMatch(html, /class="sc-pane-toggle"/, "listing must NOT render the Structural/Preview toggle");
  assert.doesNotMatch(html, /sc-preview-frame/, "listing must NOT render the preview iframe");
  // The structural editing pane (block list) stays — the sidebar zone renders.
  assert.match(html, /data-sc-zone="sidebar"/, "listing must keep the structural block list");
  // The notice is shown instead.
  assert.match(html, /data-sc-preview-unavailable/, "listing missing the preview-unavailable notice");
  assert.match(html, /siteConfig\.design\.previewPane\.unavailable/, "listing missing the unavailable i18n string");
});

test("editor view (no-JS add path): a listing sidebar zone offers a constrained ['sidebar'] block, not a main-only one (6.3 #29)", () => {
  // The noscript per-zone add forms render an add form for each available block
  // whose regions INCLUDE the zone ({% if zone.name in entry.regions %}). With
  // groupAvailableBlocks constraining regions to the surface's zones, a block
  // constrained to ["sidebar"] surfaces in the sidebar zone; a (hypothetical,
  // unconstrained) main-only block does NOT — there is no main zone here.
  const blocks = RENDER_BLOCKS();
  const html = renderEditorContent({
    ...RENDER_BASE, supportsArrangement: false, supportsLivePreview: false,
    surfaceBase: "/site-config/design/listing",
    zoneNames: ["sidebar"],
    zones: { sidebar: blocks.sidebar },
    blocks: { sidebar: blocks.sidebar },
    availableBlocks: [
      { group: "built-in", blocks: [
        { id: "author-card", label: "Author", icon: "user", description: "", regions: ["sidebar"], dormant: false },
        // A main-only block must never reach the sidebar zone's add forms.
        { id: "featured-posts", label: "Featured", icon: "star", description: "", regions: ["main"], dormant: false },
      ]},
    ],
  });
  // The noscript sidebar add-form for the sidebar-constrained block is present.
  assert.match(
    html,
    /<input type="hidden" name="type" value="author-card">\s*<input type="hidden" name="zone" value="sidebar">/,
    "sidebar-constrained block must offer a sidebar add form",
  );
  // The main-only block has no sidebar add form (zone.name 'sidebar' ∉ ['main']).
  assert.doesNotMatch(
    html,
    /name="type" value="featured-posts"/,
    "main-only block must NOT appear in the listing's sidebar add forms",
  );
});

test("editor view renders the per-surface editor title/intro keys (6.3 #28)", () => {
  const blocks = RENDER_BLOCKS();
  const html = renderEditorContent({
    ...RENDER_BASE, supportsArrangement: false, supportsLivePreview: false,
    surfaceBase: "/site-config/design/listing",
    zoneNames: ["sidebar"],
    zones: { sidebar: blocks.sidebar },
    blocks: { sidebar: blocks.sidebar }, availableBlocks: RENDER_AVAILABLE(),
    editorTitleKey: "siteConfig.design.editor.listingTitle",
    editorIntroKey: "siteConfig.design.editor.listingDescription",
  });
  // The view resolves __(editorTitleKey)/__(editorIntroKey) — the mock echoes
  // the key, proving the H1/intro are NOT hardcoded to the homepage strings.
  assert.match(html, /siteConfig\.design\.editor\.listingTitle/, "listing H1 must use editorTitleKey");
  assert.match(html, /siteConfig\.design\.editor\.listingDescription/, "listing intro must use editorIntroKey");
  assert.doesNotMatch(html, /siteConfig\.design\.editor\.title/, "listing must NOT render the homepage title key");
});

// ---- recipes ----

test("POST apply-recipe over an existing doc saves a draft (published tree untouched)", async () => {
  const ik = makeIndiekit();
  const res = await callRoute(makeRouter(ik), "post", "/homepage/apply-recipe", { recipeId: "blog" });
  assert.equal(flag(res, "recipe"), "1");
  const doc = ik._db.stores.compositions.get("homepage");
  assert.ok(doc.draftTree);
  assert.deepEqual(treeToZones(doc.tree).main.map((n) => n.id), ["b_m1", "b_m2"]); // published untouched
  const zones = draftZones(ik);
  assert.equal(zones.hero.type, "hero");
  assert.equal(zones.arrangement, "sidebar-right"); // blog preset is two-column
  assert.deepEqual(zones.main.map((n) => n.type), ["recent-posts"]);
});

test("POST apply-recipe with NO composition creates the doc (atomic upsert path)", async () => {
  const ik = makeIndiekit({ compositions: [] });
  const res = await callRoute(makeRouter(ik), "post", "/homepage/apply-recipe", { recipeId: "blog" });
  assert.equal(flag(res, "recipe"), "1");
  const doc = ik._db.stores.compositions.get("homepage");
  assert.equal(doc.schemaVersion, 4);
  assert.equal(doc.kind, "homepage");
  assert.equal(doc.status, "draft");
  assert.ok(doc.draftTree);
  assert.equal("tree" in doc, false); // nothing published yet
});

test("POST apply-recipe unknown recipe / custom tree rejections", async () => {
  const bad = await callRoute(makeRouter(makeIndiekit()), "post", "/homepage/apply-recipe", { recipeId: "nope" });
  assert.equal(flag(bad, "error"), "unknown-recipe");
  const ikCustom = makeIndiekit({ compositions: [homepageDoc({ tree: customTree() })] });
  const custom = await callRoute(makeRouter(ikCustom), "post", "/homepage/apply-recipe", { recipeId: "blog" });
  assert.equal(flag(custom, "error"), "custom-tree");
});

// ---- publish / discard ----

test("POST publish promotes the draft and writes the artifact", async () => {
  const ik = makeIndiekit({ compositions: [homepageDoc({ draftTree: baseTree(), draftUpdatedAt: "D1" })] });
  const artifacts = [];
  const router = makeRouter(ik, { writeArtifact: async (doc) => artifacts.push(doc) });
  const res = await callRoute(router, "post", "/homepage/publish");
  assert.match(flag(res, "published"), /^\d{13,}$/); // publish epoch (ms)
  assert.equal(artifacts.length, 1);
  const doc = ik._db.stores.compositions.get("homepage");
  assert.equal("draftTree" in doc, false);
  assert.equal(doc.status, "published");
});

test("publish redirect carries the injected clock's epoch as an integer (?published=<ms>)", async () => {
  const epoch = Date.parse("2026-06-13T12:00:00.000Z");
  const ik = makeIndiekit({ compositions: [homepageDoc({ draftTree: baseTree(), draftUpdatedAt: "D1" })] });
  const router = makeRouter(ik, { writeArtifact: async () => {}, now: () => epoch });
  const res = await callRoute(router, "post", "/homepage/publish");
  const value = flag(res, "published");
  assert.equal(value, String(epoch)); // SERVER clock — same seam as finishedAt/stuck math
  const parsed = Number(value);
  assert.ok(Number.isInteger(parsed) && parsed > 1e12); // editor.js plausibility gate
});

test("POST publish invalid draft → publish-invalid flash, nothing written", async () => {
  const badTree = baseTree();
  badTree.children[1].children[0].children[0].config = { maxItems: 999 };
  const ik = makeIndiekit({ compositions: [homepageDoc({ draftTree: badTree, draftUpdatedAt: "D1" })] });
  const artifacts = [];
  const router = makeRouter(ik, { writeArtifact: async (doc) => artifacts.push(doc) });
  const res = await callRoute(router, "post", "/homepage/publish");
  assert.equal(flag(res, "error"), "publish-invalid");
  assert.equal(artifacts.length, 0);
  assert.ok(ik._db.stores.compositions.get("homepage").draftTree); // draft retained
});

test("POST publish conflict (racing draft) → conflict flash", async () => {
  const ik = makeIndiekit({ compositions: [homepageDoc({ draftTree: baseTree(), draftUpdatedAt: "D1" })] });
  const realDb = ik.database;
  ik.database = {
    collection(name) {
      const col = realDb.collection(name);
      return {
        ...col,
        async findOne(query) {
          const doc = await col.findOne(query);
          const snapshot = structuredClone(doc);
          if (doc && name === "compositions") doc.draftUpdatedAt = "D2-racer";
          return snapshot;
        },
      };
    },
  };
  const router = makeRouter(ik, { writeArtifact: async () => {} });
  const res = await callRoute(router, "post", "/homepage/publish");
  assert.equal(flag(res, "error"), "conflict");
});

test("POST publish with no composition → no-composition flash", async () => {
  const ik = makeIndiekit({ compositions: [] });
  const router = makeRouter(ik, { writeArtifact: async () => {} });
  const res = await callRoute(router, "post", "/homepage/publish");
  assert.equal(flag(res, "error"), "no-composition");
});

test("POST discard drops the draft", async () => {
  const ik = makeIndiekit({ compositions: [homepageDoc({ draftTree: baseTree(), draftUpdatedAt: "D" })] });
  const res = await callRoute(makeRouter(ik), "post", "/homepage/discard");
  assert.equal(flag(res, "discarded"), "1");
  assert.equal("draftTree" in ik._db.stores.compositions.get("homepage"), false);
});

// ---- preview (Phase 5) ----

const previewState = (ik) => {
  const doc = ik._db.stores.siteConfig.get("primary") ?? {};
  return { token: doc.previewToken, revision: doc.previewRevision };
};

test("POST preview (no-JS) writes the artifact and redirects with pane + revision", async () => {
  const ik = makeIndiekit();
  const previews = [];
  const router = makeRouter(ik, { writePreviewArtifact: async (input) => previews.push(input) });
  const res = await callRoute(router, "post", "/homepage/preview");
  assert.equal(res.redirected.status, 303);
  assert.equal(flag(res, "pane"), "preview");
  assert.equal(flag(res, "previewing"), "1");
  // token generated (16 bytes base64url ≈ 22 chars), revision bumped to 1
  const state = previewState(ik);
  assert.equal(state.token.length, 22);
  assert.equal(state.revision, 1);
  // artifact carries the PUBLISHED tree (no draft exists) + token + revision
  assert.equal(previews.length, 1);
  assert.deepEqual(previews[0], { tree: baseTree(), revision: 1, token: state.token });
});

test("POST preview uses the DRAFT tree when one exists", async () => {
  const draft = baseTree();
  draft.children[1].children[0].children[0].config = { maxItems: 42 };
  const ik = makeIndiekit({ compositions: [homepageDoc({ draftTree: draft, draftUpdatedAt: "D" })] });
  const previews = [];
  const router = makeRouter(ik, { writePreviewArtifact: async (input) => previews.push(input) });
  await callRoute(router, "post", "/homepage/preview");
  assert.deepEqual(previews[0].tree, draft);
});

test("POST preview JSON branch (Accept: application/json) returns token/revision/expectedSeconds", async () => {
  const ik = makeIndiekit();
  const previews = [];
  const router = makeRouter(ik, {
    writePreviewArtifact: async (input) => previews.push(input),
    readStatus: async () => ({ state: "ok", lastOkDurationSeconds: 27 }),
  });
  const res = await callRoute(router, "post", "/homepage/preview", {}, { accept: "application/json" });
  assert.equal(res.redirected, null);
  assert.equal(res.jsonBody.expectedSeconds, 27);
  assert.equal(res.jsonBody.revision, 1);
  assert.equal(res.jsonBody.token, previewState(ik).token);
  assert.equal(previews.length, 1);
});

test("POST preview JSON: expectedSeconds null when build-status absent or malformed", async () => {
  for (const status of [null, {}, { lastOkDurationSeconds: "27" }]) {
    const ik = makeIndiekit();
    const router = makeRouter(ik, { readStatus: async () => status });
    const res = await callRoute(router, "post", "/homepage/preview", {}, { accept: "application/json" });
    assert.equal(res.jsonBody.expectedSeconds, null, JSON.stringify(status));
  }
});

test("repeated preview POSTs reuse the token and bump the revision monotonically", async () => {
  const ik = makeIndiekit();
  const previews = [];
  const router = makeRouter(ik, { writePreviewArtifact: async (input) => previews.push(input) });
  await callRoute(router, "post", "/homepage/preview");
  const first = previewState(ik);
  const res = await callRoute(router, "post", "/homepage/preview");
  const second = previewState(ik);
  assert.equal(second.token, first.token); // ensureToken never regenerates
  assert.equal(second.revision, 2);
  assert.equal(flag(res, "previewing"), "2");
  assert.deepEqual(previews.map((p) => p.revision), [1, 2]);
});

test("POST preview ALLOWS custom trees (only the editor is read-only for them)", async () => {
  const ik = makeIndiekit({ compositions: [homepageDoc({ tree: customTree() })] });
  const previews = [];
  const router = makeRouter(ik, { writePreviewArtifact: async (input) => previews.push(input) });
  const res = await callRoute(router, "post", "/homepage/preview");
  assert.equal(flag(res, "pane"), "preview"); // success, not a custom-tree flash
  assert.deepEqual(previews[0].tree, customTree());
});

test("POST preview with no composition → no-composition flash, nothing written", async () => {
  const ik = makeIndiekit({ compositions: [] });
  const previews = [];
  const router = makeRouter(ik, { writePreviewArtifact: async (input) => previews.push(input) });
  const res = await callRoute(router, "post", "/homepage/preview");
  assert.equal(flag(res, "error"), "no-composition");
  assert.equal(previews.length, 0);
  assert.equal(ik._db.stores.siteConfig.size, 0); // no token/revision minted either
});

test("POST preview with no database → 503", async () => {
  const ik = makeIndiekit();
  ik.database = null;
  const res = await callRoute(makeRouter(ik), "post", "/homepage/preview");
  assert.equal(res.statusCode, 503);
});

// ---- live-preview capability gate (6.3 #31 stopgap) ----
//
// The preview is a SINGLE shared slot (preview-draft.json + one token on the
// siteConfig singleton). Only the surface that OWNS it (homepage) may write it.
// The listing surface OMITS supportsLivePreview → its /preview route 404s
// BEFORE writing, so it can never overwrite (corrupt) the homepage slot.

test("POST /listing/preview 404s (no live-preview capability) and never touches the shared slot", async () => {
  // Real registry: listing is live and OMITS supportsLivePreview. Seed a
  // homepage preview slot (token/revision) so we can prove it stays untouched.
  const ik = makeIndiekit({
    compositions: [sidebarDoc()],
    siteConfig: [{ _id: "primary", previewToken: "homepage-token", previewRevision: 7 }],
  });
  const previews = [];
  const router = makeRouter(ik, { writePreviewArtifact: async (input) => previews.push(input) });
  const res = await callRoute(router, "post", "/listing/preview");
  assert.equal(res.statusCode, 404);
  // No preview draft written — the gate precedes the write.
  assert.equal(previews.length, 0);
  // The shared homepage preview slot is byte-identical (token NOT rotated,
  // revision NOT bumped).
  const slot = ik._db.stores.siteConfig.get("primary");
  assert.equal(slot.previewToken, "homepage-token");
  assert.equal(slot.previewRevision, 7);
});

test("POST /homepage/preview still writes the shared slot (capability owner unchanged)", async () => {
  // Regression guard: the gate must not break the homepage owner.
  const ik = makeIndiekit();
  const previews = [];
  const router = makeRouter(ik, { writePreviewArtifact: async (input) => previews.push(input) });
  const res = await callRoute(router, "post", "/homepage/preview");
  assert.equal(res.redirected.status, 303);
  assert.equal(flag(res, "pane"), "preview");
  assert.equal(previews.length, 1);
});

// ---- per-surface editor locals (6.3 #31 + #28) ----

test("editorLocals: homepage exposes supportsLivePreview true + the existing editor copy keys", async () => {
  const res = await callRoute(makeRouter(makeIndiekit()), "get", "/homepage");
  const { locals } = res.rendered;
  assert.equal(locals.supportsLivePreview, true);
  assert.equal(locals.editorTitleKey, "siteConfig.design.editor.title");
  assert.equal(locals.editorIntroKey, "siteConfig.design.editor.description");
});

test("editorLocals: listing exposes supportsLivePreview false + its own editor copy keys", async () => {
  const ik = makeIndiekit({ compositions: [sidebarDoc()] });
  const res = await callRoute(makeRouter(ik), "get", "/listing");
  const { locals } = res.rendered;
  assert.equal(locals.supportsLivePreview, false);
  assert.equal(locals.editorTitleKey, "siteConfig.design.editor.listingTitle");
  assert.equal(locals.editorIntroKey, "siteConfig.design.editor.listingDescription");
});

test("GET /homepage pane state: default structural, ?pane=preview selects preview", async () => {
  const ik = makeIndiekit({ siteConfig: [{ _id: "primary", previewToken: "tok22", previewRevision: 4 }] });
  const router = makeRouter(ik);
  const structural = await callRoute(router, "get", "/homepage");
  assert.equal(structural.rendered.locals.pane, "structural");
  const preview = await callRoute(router, "get", "/homepage?pane=preview&previewing=4");
  assert.equal(preview.rendered.locals.pane, "preview");
  assert.deepEqual(preview.rendered.locals.preview, { token: "tok22", revision: 4 });
  assert.equal(preview.rendered.locals.previewing, "4");
  // garbage pane values fall back to structural
  const garbage = await callRoute(router, "get", "/homepage?pane=banana");
  assert.equal(garbage.rendered.locals.pane, "structural");
});

test("GET /homepage with no preview state yet → token null, revision 0", async () => {
  const res = await callRoute(makeRouter(makeIndiekit()), "get", "/homepage");
  assert.deepEqual(res.rendered.locals.preview, { token: null, revision: 0 });
  assert.equal(res.rendered.locals.previewing, null);
});

test("publish rotates the token, bumps the revision, writes a FRESH preview-draft from the published tree", async () => {
  const draft = baseTree();
  draft.children[1].children[0].children[0].config = { maxItems: 42 };
  const ik = makeIndiekit({
    compositions: [homepageDoc({ draftTree: draft, draftUpdatedAt: "D1" })],
    siteConfig: [{ _id: "primary", previewToken: "old-token", previewRevision: 5 }],
  });
  const previews = [];
  const router = makeRouter(ik, {
    writeArtifact: async () => {},
    writePreviewArtifact: async (input) => previews.push(input),
  });
  const res = await callRoute(router, "post", "/homepage/publish");
  assert.match(flag(res, "published"), /^\d{13,}$/);
  const state = previewState(ik);
  assert.notEqual(state.token, "old-token"); // rotated unconditionally
  assert.equal(state.token.length, 22);
  assert.equal(state.revision, 6);
  // fresh artifact: the NOW-PUBLISHED tree under the NEW token/revision
  assert.equal(previews.length, 1);
  assert.deepEqual(previews[0], { tree: draft, revision: 6, token: state.token });
});

test("rejected publish (invalid draft) does NOT rotate the token or write a preview", async () => {
  const badTree = baseTree();
  badTree.children[1].children[0].children[0].config = { maxItems: 999 };
  const ik = makeIndiekit({
    compositions: [homepageDoc({ draftTree: badTree, draftUpdatedAt: "D1" })],
    siteConfig: [{ _id: "primary", previewToken: "old-token", previewRevision: 5 }],
  });
  const previews = [];
  const router = makeRouter(ik, {
    writeArtifact: async () => {},
    writePreviewArtifact: async (input) => previews.push(input),
  });
  const res = await callRoute(router, "post", "/homepage/publish");
  assert.equal(flag(res, "error"), "publish-invalid");
  assert.deepEqual(previewState(ik), { token: "old-token", revision: 5 });
  assert.equal(previews.length, 0);
});

test("a preview-rotation failure after a successful publish still redirects published=1", async () => {
  const ik = makeIndiekit({ compositions: [homepageDoc({ draftTree: baseTree(), draftUpdatedAt: "D1" })] });
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const router = makeRouter(ik, {
      writeArtifact: async () => {},
      writePreviewArtifact: async () => { throw new Error("disk full"); },
    });
    const res = await callRoute(router, "post", "/homepage/publish");
    assert.match(flag(res, "published"), /^\d{13,}$/); // publish success is never masked
    assert.ok(warnings.some((w) => w.includes("preview rotation after publish failed")));
  } finally {
    console.warn = original;
  }
});

test("publishing the listing surface does NOT rotate/overwrite the shared homepage preview slot (6.3 #31)", async () => {
  // Sibling of the /preview gate: the publish handler's preview-rotation block
  // writes the SINGLE shared slot (siteConfig token/revision + preview-draft.json).
  // The listing surface OMITS supportsLivePreview, so a listing publish must NOT
  // touch that slot — otherwise it rotates the homepage token and overwrites the
  // homepage preview-draft with the sidebar-only listing tree.
  const ik = makeIndiekit({
    compositions: [
      { ...sidebarDoc(), draftTree: sidebarDoc().tree, draftUpdatedAt: "D1" },
    ],
    // A homepage-owned preview slot seeded BEFORE the listing publish.
    siteConfig: [{ _id: "primary", previewToken: "homepage-token", previewRevision: 9 }],
  });
  const previews = [];
  const router = makeRouter(ik, {
    writeArtifact: async () => {},
    writePreviewArtifact: async (input) => previews.push(input),
  });
  const res = await callRoute(router, "post", "/listing/publish");
  // Publish itself succeeds (db promote + writeCompositionJson + redirect).
  assert.match(flag(res, "published"), /^\d{13,}$/);
  const doc = ik._db.stores.compositions.get("collection:default");
  assert.equal("draftTree" in doc, false); // draft promoted
  assert.equal(doc.status, "published");
  // The shared preview slot is byte-identical (token NOT rotated, revision NOT
  // bumped) and NO preview-draft artifact was written.
  assert.deepEqual(previewState(ik), { token: "homepage-token", revision: 9 });
  assert.equal(previews.length, 0);
});

// ---- postType (post sidebar) surface capabilities (6.4-T2) ----
//
// The postType surface mirrors the listing surface: sidebar-only, NO
// arrangement axis, NO live-preview ownership. The casing trap: routeKey/hubKey
// are lowercase "posttype"; surfaceFilter/kind are camelCase "postType".

test("POST /posttype/arrangement 404s (no arrangement axis) without writing a draft (6.4-T2)", async () => {
  const ik = makeIndiekit({ compositions: [posttypeDoc()] });
  const res = await callRoute(makeRouter(ik), "post", "/posttype/arrangement", { arrangement: "stack" });
  assert.equal(res.statusCode, 404);
  // The capability gate precedes any zone access — no draft written.
  assert.equal("draftTree" in ik._db.stores.compositions.get("posttype:default"), false);
});

test("POST /posttype/preview 404s (no live-preview capability) and never touches the shared slot (6.4-T2)", async () => {
  // Seed a homepage-owned preview slot so we can prove it stays untouched.
  const ik = makeIndiekit({
    compositions: [posttypeDoc()],
    siteConfig: [{ _id: "primary", previewToken: "homepage-token", previewRevision: 7 }],
  });
  const previews = [];
  const router = makeRouter(ik, { writePreviewArtifact: async (input) => previews.push(input) });
  const res = await callRoute(router, "post", "/posttype/preview");
  assert.equal(res.statusCode, 404);
  // No preview draft written — the gate precedes the write.
  assert.equal(previews.length, 0);
  // The shared homepage preview slot is byte-identical (token NOT rotated,
  // revision NOT bumped).
  const slot = ik._db.stores.siteConfig.get("primary");
  assert.equal(slot.previewToken, "homepage-token");
  assert.equal(slot.previewRevision, 7);
});

test("publishing the posttype surface succeeds but does NOT rotate/overwrite the shared homepage preview slot (6.4-T2)", async () => {
  const ik = makeIndiekit({
    compositions: [
      { ...posttypeDoc(), draftTree: posttypeDoc().tree, draftUpdatedAt: "D1" },
    ],
    // A homepage-owned preview slot seeded BEFORE the posttype publish.
    siteConfig: [{ _id: "primary", previewToken: "homepage-token", previewRevision: 9 }],
  });
  const previews = [];
  const router = makeRouter(ik, {
    writeArtifact: async () => {},
    writePreviewArtifact: async (input) => previews.push(input),
  });
  const res = await callRoute(router, "post", "/posttype/publish");
  // Publish itself succeeds (db promote + writeCompositionJson + redirect).
  assert.match(flag(res, "published"), /^\d{13,}$/);
  const doc = ik._db.stores.compositions.get("posttype:default");
  assert.equal("draftTree" in doc, false); // draft promoted
  assert.equal(doc.status, "published");
  // The shared preview slot is byte-identical and NO preview-draft was written.
  assert.deepEqual(previewState(ik), { token: "homepage-token", revision: 9 });
  assert.equal(previews.length, 0);
});

test("groupAvailableBlocks (surfaceFilter 'postType', regions ['sidebar']) offers the post-sidebar blocks — NOT an empty picker (6.4 casing-trap guard)", () => {
  // The casing trap: surfaceFilter MUST be camelCase "postType" to match the
  // placement.surfaces strings in builtin-blocks.js. With lowercase "posttype"
  // the picker would be empty (the 6.3-class CRITICAL bug). availableRegions
  // ["sidebar"] = the sidebar zone-model's region values.
  const groups = groupAvailableBlocks(BUILTIN_BLOCKS, new Set(), {
    surfaceFilter: "postType",
    availableRegions: ["sidebar"],
  });
  const ids = groups.flatMap((g) => g.blocks).map((b) => b.id);
  // postType + sidebar blocks must be offered.
  for (const id of ["toc", "post-categories", "share", "author-card"]) {
    assert.ok(ids.includes(id), `${id} must be offered on the postType sidebar`);
  }
  // A homepage-only / non-postType block must NOT leak in (e.g. featured-posts:
  // surfaces [homepage, collection], region main — fails both gates).
  assert.equal(ids.includes("featured-posts"), false, "featured-posts is not a postType sidebar block");
  // social-activity is homepage-only (surfaces ["homepage"]) — excluded by the
  // surface gate even though it's a sidebar block.
  assert.equal(ids.includes("social-activity"), false, "social-activity (homepage-only) must not appear");
});

// ---- build-status API (Phase 5 S2) ----

const T0 = Date.parse("2026-06-12T10:00:00.000Z");
const atT0 = (offsetMs = 0) => () => T0 + offsetMs;
const buildingStatus = (extra = {}) => ({
  state: "building",
  buildId: "b9",
  startedAt: "2026-06-12T10:00:00.000Z",
  ...extra,
});

const statusDir = () => mkdtemp(join(tmpdir(), "design-build-status-"));

/** Invoke the standalone handler factory directly (no router). */
function callHandler(handler) {
  return new Promise((resolve, reject) => {
    const res = {
      headers: {},
      jsonBody: null,
      set(name, value) { this.headers[name] = value; return this; },
      json(payload) { this.jsonBody = payload; resolve(this); },
    };
    handler({}, res, (error) => reject(error ?? new Error("unexpected next()")));
  });
}

test("isStuckBuild: building past max(2*lastOk, 120)s is stuck, within it is not", () => {
  // lastOk 27 → 2*27=54 < the 120s floor → threshold 120s (first post-boot
  // builds are FULL — the floor prevents false stuck on them)
  const fast = buildingStatus({ lastOkDurationSeconds: 27 });
  assert.equal(isStuckBuild(fast, T0 + 119_000), false);
  assert.equal(isStuckBuild(fast, T0 + 121_000), true);
  // lastOk 300 → threshold 600s (the floor doesn't cap big sites)
  const slow = buildingStatus({ lastOkDurationSeconds: 300 });
  assert.equal(isStuckBuild(slow, T0 + 599_000), false);
  assert.equal(isStuckBuild(slow, T0 + 601_000), true);
});

test("isStuckBuild: lastOkDurationSeconds absent or garbage defaults to 60 (→ 120s threshold)", () => {
  for (const extra of [{}, { lastOkDurationSeconds: "27" }, { lastOkDurationSeconds: -5 }]) {
    const status = buildingStatus(extra);
    assert.equal(isStuckBuild(status, T0 + 119_000), false, JSON.stringify(extra));
    assert.equal(isStuckBuild(status, T0 + 121_000), true, JSON.stringify(extra));
  }
});

test("isStuckBuild: a building object missing or garbling startedAt is NEVER stuck", () => {
  // start.sh's crash wrapper drops fields — tolerate everywhere
  assert.equal(isStuckBuild({ state: "building" }, T0 + 999_999_000), false);
  assert.equal(isStuckBuild(buildingStatus({ startedAt: "yesterday" }), T0 + 999_999_000), false);
  assert.equal(isStuckBuild(buildingStatus({ startedAt: 12345 }), T0 + 999_999_000), false);
});

test("isStuckBuild: non-building states are never stuck", () => {
  for (const state of ["ok", "failed", "unknown", "garbage", undefined]) {
    assert.equal(isStuckBuild({ state, startedAt: "2026-06-12T10:00:00.000Z" }, T0 + 999_999_000), false, String(state));
  }
});

test("mergeBuildStatus: null → unknown; otherwise raw fields + stuck ride together", () => {
  assert.deepEqual(mergeBuildStatus(null, T0), { state: "unknown", stuck: false });
  const status = buildingStatus({ lastOkDurationSeconds: 27, incremental: true });
  assert.deepEqual(mergeBuildStatus(status, T0 + 130_000), { ...status, stuck: true });
  assert.deepEqual(mergeBuildStatus(status, T0 + 10_000), { ...status, stuck: false });
});

test("mergeBuildStatus strips an unparseable finishedAt (the | date filter would crash on it)", () => {
  for (const finishedAt of ["garbage", "8 Feb 2025 oops no", 12_345, null, {}]) {
    const merged = mergeBuildStatus({ state: "ok", finishedAt }, T0);
    assert.equal("finishedAt" in merged, false, JSON.stringify(finishedAt));
    assert.equal(merged.state, "ok");
  }
  // a valid ISO string passes through; the caller's object is never mutated
  const status = { state: "ok", finishedAt: "2026-06-12T10:00:27.000Z" };
  assert.equal(mergeBuildStatus(status, T0).finishedAt, status.finishedAt);
  const garbage = { state: "ok", finishedAt: "garbage" };
  mergeBuildStatus(garbage, T0);
  assert.equal(garbage.finishedAt, "garbage");
});

test("GET /api/build-status responds the merged object with Cache-Control: no-store", async () => {
  const status = {
    state: "ok", buildId: "b1", startedAt: "2026-06-12T09:59:00.000Z",
    finishedAt: "2026-06-12T10:00:00.000Z", durationSeconds: 27,
    incremental: true, lastOkDurationSeconds: 27,
  };
  const router = makeRouter(makeIndiekit(), { readStatus: async () => status, now: atT0() });
  const res = await callRoute(router, "get", "/api/build-status");
  assert.deepEqual(res.jsonBody, { ...status, stuck: false });
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("GET /api/build-status computes stuck for an overdue building state", async () => {
  const status = buildingStatus({ lastOkDurationSeconds: 27 });
  const router = makeRouter(makeIndiekit(), {
    readStatus: async () => status,
    now: atT0(130_000),
  });
  const res = await callRoute(router, "get", "/api/build-status");
  assert.deepEqual(res.jsonBody, { ...status, stuck: true });
});

test("build-status handler: absent file → state unknown (fixture path, real reader)", async () => {
  const path = join(await statusDir(), "build-status.json"); // never written
  const handler = buildStatusHandler({ readStatus: () => readBuildStatus(path) });
  const res = await callHandler(handler);
  assert.deepEqual(res.jsonBody, { state: "unknown", stuck: false });
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("build-status handler: corrupt file NEVER 500s → state unknown (fixture path)", async () => {
  const path = join(await statusDir(), "build-status.json");
  await writeFile(path, "{ this is not json", "utf8");
  const handler = buildStatusHandler({ readStatus: () => readBuildStatus(path) });
  const res = await callHandler(handler);
  assert.deepEqual(res.jsonBody, { state: "unknown", stuck: false });
});

test("build-status handler: minimal failed-writer file (fields dropped) passes through", async () => {
  // start.sh's crash wrapper writes ONLY {state, error, finishedAt}
  const path = join(await statusDir(), "build-status.json");
  const minimal = { state: "failed", error: "Eleventy exited 1", finishedAt: "2026-06-12T10:01:00.000Z" };
  await writeFile(path, JSON.stringify(minimal), "utf8");
  const handler = buildStatusHandler({ readStatus: () => readBuildStatus(path), now: atT0(999_000) });
  const res = await callHandler(handler);
  assert.deepEqual(res.jsonBody, { ...minimal, stuck: false });
});

test("GET /homepage?published=1 carries the merged build status in the locals (no-JS strip)", async () => {
  const status = buildingStatus({ lastOkDurationSeconds: 27 });
  const router = makeRouter(makeIndiekit(), {
    readStatus: async () => status,
    now: atT0(130_000),
  });
  const res = await callRoute(router, "get", "/homepage?published=1");
  assert.equal(res.rendered.locals.success, "published");
  assert.deepEqual(res.rendered.locals.buildStatus, { ...status, stuck: true });
});

test("GET /homepage?published=<epoch> gates the strip the same way (truthy, value never rendered)", async () => {
  const status = buildingStatus({ lastOkDurationSeconds: 27 });
  const router = makeRouter(makeIndiekit(), {
    readStatus: async () => status,
    now: atT0(10_000),
  });
  const res = await callRoute(router, "get", `/homepage?published=${T0}`);
  assert.equal(res.rendered.locals.success, "published");
  assert.deepEqual(res.rendered.locals.buildStatus, { ...status, stuck: false });
  // the raw epoch must not leak into the template locals
  assert.equal("published" in res.rendered.locals, false);
});

test("GET /homepage?published=1 with no status file → buildStatus unknown in locals", async () => {
  const router = makeRouter(makeIndiekit(), { readStatus: async () => null });
  const res = await callRoute(router, "get", "/homepage?published=1");
  assert.deepEqual(res.rendered.locals.buildStatus, { state: "unknown", stuck: false });
});

test("GET /homepage?published=1 with garbage finishedAt → field stripped from locals (the no-JS GET never crashes the | date filter)", async () => {
  const router = makeRouter(makeIndiekit(), {
    readStatus: async () => ({ state: "ok", finishedAt: "garbage" }),
  });
  const res = await callRoute(router, "get", "/homepage?published=1");
  // the view's ok branch is gated on finishedAt — with it stripped, the
  // strip renders the neutral no-time copy instead of feeding garbage to
  // date-fns parseISO
  assert.deepEqual(res.rendered.locals.buildStatus, { state: "ok", stuck: false });
});

test("GET /homepage without ?published does not read the status file", async () => {
  let calls = 0;
  const router = makeRouter(makeIndiekit(), { readStatus: async () => { calls++; return null; } });
  const res = await callRoute(router, "get", "/homepage");
  assert.equal(calls, 0);
  assert.equal(res.rendered.locals.buildStatus, undefined);
});

// ---- mode ----

test("POST /mode persists designMode and GET reflects it", async () => {
  const ik = makeIndiekit();
  const router = makeRouter(ik);
  const res = await callRoute(router, "post", "/mode", { mode: "advanced" });
  assert.equal(res.redirected.url, "/site-config/design/homepage");
  assert.equal(ik._db.stores.siteConfig.get("primary").designMode, "advanced");
  const get = await callRoute(router, "get", "/homepage");
  assert.equal(get.rendered.locals.mode, "advanced");
});

test("POST /mode rejects unknown modes", async () => {
  const ik = makeIndiekit();
  const res = await callRoute(makeRouter(ik), "post", "/mode", { mode: "wizard" });
  assert.equal(flag(res, "error"), "invalid-mode");
  assert.equal(ik._db.stores.siteConfig.size, 0);
});
