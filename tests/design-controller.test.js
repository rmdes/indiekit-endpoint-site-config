import { test } from "node:test";
import assert from "node:assert/strict";
import {
  designRouter,
  parseAddBody,
  parseZone,
  placementAllows,
  encodeUndoPayload,
  parseUndoPayload,
  readFlash,
} from "../lib/controllers/design.js";
import { treeToZones } from "../lib/editor/zones.js";
import { BUILTIN_BLOCKS } from "../lib/presets/builtin-blocks.js";
import { LAYOUT_PRESETS } from "../lib/presets/layout-presets.js";

const makeIds = () => { let n = 0; return (prefix) => `${prefix}_${String(++n).padStart(6, "0")}`; };

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

test("parseZone accepts the four zones only", () => {
  for (const zone of ["hero", "main", "sidebar", "footer"]) assert.equal(parseZone(zone), zone);
  for (const bad of ["root", "", undefined, null, "MAIN", 3]) assert.equal(parseZone(bad), null);
});

test("parseAddBody validates zone before type (zone errors win)", () => {
  assert.deepEqual(parseAddBody({ zone: "main", type: "hero" }), { zone: "main", type: "hero" });
  assert.deepEqual(parseAddBody({ zone: "attic", type: "hero" }), { error: "invalid-zone" });
  assert.deepEqual(parseAddBody({ zone: "main" }), { error: "unknown-type" });
  assert.deepEqual(parseAddBody(undefined), { error: "invalid-zone" });
});

test("placementAllows maps zones to placement regions", () => {
  const hero = CATALOG.find((e) => e.id === "hero");
  const recent = CATALOG.find((e) => e.id === "recent-posts");
  assert.equal(placementAllows(hero, "hero"), true);
  assert.equal(placementAllows(hero, "main"), false);
  assert.equal(placementAllows(recent, "main"), true);
  assert.equal(placementAllows(recent, "footer"), false);
  assert.equal(placementAllows(undefined, "main"), false);
});

test("undo payload round-trips; oversized/garbage tokens → null", () => {
  const removed = { node: section("b_x", "recent-posts", { maxItems: 5 }), zone: "main", index: 1 };
  const token = encodeUndoPayload(removed);
  assert.deepEqual(parseUndoPayload(token), removed);
  assert.equal(parseUndoPayload("!!!not-base64-json"), null);
  assert.equal(parseUndoPayload("A".repeat(5000)), null);
  assert.equal(parseUndoPayload(undefined), null);
  // container nodes and bad zones are rejected at parse time
  const container = encodeUndoPayload({ node: { block: "container", id: "c_x" }, zone: "main", index: 0 });
  assert.equal(parseUndoPayload(container), null);
  const badZone = encodeUndoPayload({ node: section("b_x", "t"), zone: "attic", index: 0 });
  assert.equal(parseUndoPayload(badZone), null);
});

test("parseUndoPayload structurally rejects non-object configs (schema-gate leniency bypass)", () => {
  // validateConfigAgainstSchema treats non-object configs as empty with
  // ok:true — this structural gate is what actually stops them (HIGH-1).
  for (const config of ["evil", 42, true, ["evil"], null]) {
    const token = encodeUndoPayload({
      node: { block: "section", id: "b_x", type: "recent-posts", v: 0, config },
      zone: "main", index: 0,
    });
    assert.equal(parseUndoPayload(token), null, JSON.stringify(config));
  }
  // ABSENT config is fine (the handler rebuilds with {})
  const absent = encodeUndoPayload({
    node: { block: "section", id: "b_x", type: "recent-posts", v: 0 },
    zone: "main", index: 0,
  });
  assert.ok(parseUndoPayload(absent));
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

test("GET / renders the hub with 4 surface cards (homepage live, rest disabled)", async () => {
  const ik = makeIndiekit({ compositions: [homepageDoc({ draftTree: baseTree(), draftUpdatedAt: "D" })] });
  const res = await callRoute(makeRouter(ik), "get", "/");
  assert.equal(res.rendered.view, "site-config-design");
  assert.equal(res.rendered.locals.activeTab, "design");
  const { surfaces } = res.rendered.locals;
  assert.equal(surfaces.length, 4);
  assert.deepEqual(surfaces[0], {
    key: "homepage", href: "/site-config/design/homepage", enabled: true,
    exists: true, hasDraft: true, updatedAt: "2026-06-01T00:00:00.000Z",
  });
  assert.deepEqual(surfaces.slice(1).map((s) => s.enabled), [false, false, false]);
});

test("GET / hub: no composition → exists false, hasDraft false", async () => {
  const res = await callRoute(makeRouter(makeIndiekit({ compositions: [] })), "get", "/");
  const [homepage] = res.rendered.locals.surfaces;
  assert.equal(homepage.exists, false);
  assert.equal(homepage.hasDraft, false);
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
  const payload = parseUndoPayload(flag(res, "u"));
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
  const ghost = groups["Removed endpoint"].find((b) => b.id === "ghost-widget");
  assert.deepEqual(ghost.regions, []); // sidebar-only block has nowhere to go (picker skips it)
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
  assert.equal(flag(res, "published"), "1");
  assert.equal(artifacts.length, 1);
  const doc = ik._db.stores.compositions.get("homepage");
  assert.equal("draftTree" in doc, false);
  assert.equal(doc.status, "published");
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
  assert.equal(flag(res, "published"), "1");
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
    assert.equal(flag(res, "published"), "1"); // publish success is never masked
    assert.ok(warnings.some((w) => w.includes("preview rotation after publish failed")));
  } finally {
    console.warn = original;
  }
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
