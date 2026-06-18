import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reseedSidebarSurface,
  reseedListingComposition,
} from "../lib/storage/reseed-sidebar-surface.js";

// Deterministic id factory for assertions.
const makeIds = () => { let n = 0; return (prefix) => `${prefix}_${String(++n).padStart(6, "0")}`; };

/**
 * Stub db with siteConfig + homepageConfig + compositions stores.
 * replaceOne refuses a non-upsert miss (catches bad calls).
 */
function makeDb({ homepage, siteConfig, compositions = {} } = {}) {
  const stores = {
    siteConfig: new Map(),
    homepageConfig: new Map(),
    compositions: new Map(),
  };
  if (homepage) stores.homepageConfig.set("homepage", { _id: "homepage", ...homepage });
  if (siteConfig) stores.siteConfig.set("primary", { _id: "primary", ...siteConfig });
  for (const [id, doc] of Object.entries(compositions)) {
    stores.compositions.set(id, { _id: id, ...doc });
  }
  return {
    stores,
    collection(name) {
      const store = stores[name] ?? (stores[name] = new Map());
      return {
        async findOne({ _id }) { return store.get(_id) || null; },
        async replaceOne({ _id }, doc, opts) {
          if (!opts?.upsert && !store.has(_id)) {
            throw new Error(`replaceOne without upsert: no doc ${_id}`);
          }
          store.set(_id, doc);
        },
        async updateOne({ _id }, update, opts) {
          const existing = store.get(_id);
          if (!existing && !opts?.upsert) {
            throw new Error(`updateOne without upsert: no doc ${_id}`);
          }
          const base = existing || { _id };
          const next = { ...base };
          if (update.$set) {
            for (const [k, v] of Object.entries(update.$set)) {
              const parts = k.split(".");
              let cursor = next;
              for (let i = 0; i < parts.length - 1; i += 1) {
                cursor[parts[i]] = { ...(cursor[parts[i]] || {}) };
                cursor = cursor[parts[i]];
              }
              cursor[parts[parts.length - 1]] = v;
            }
          }
          store.set(_id, next);
        },
      };
    },
  };
}

const POSTTYPE_SPEC = {
  surfaceId: "posttype:default",
  kind: "postType",
  target: { postType: "default" },
  sourceField: "blogPostSidebar",
  gateField: "posttypeReseed",
};

const LISTING_SPEC = {
  surfaceId: "collection:default",
  kind: "collection",
  target: { collection: "default" },
  sourceField: "blogListingSidebar",
  gateField: "listingReseed",
};

const STALE_TREE = {
  block: "container", id: "c_stale", as: "stack", role: "root",
  children: [{
    block: "container", id: "c_staleinner", as: "stack", role: "complementary",
    variant: { sticky: true },
    children: [{ block: "section", id: "b_stale", type: "categories", v: 0, config: {} }],
  }],
};

const stalePosttypeDoc = {
  schemaVersion: 4, kind: "postType", target: { postType: "default" },
  status: "published", tree: STALE_TREE,
  updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "migrate-v3-to-v4",
};

// ── Posttype path ──────────────────────────────────────────────────────────

test("posttype: first run OVERWRITES posttype:default tree from current blogPostSidebar; gate set", async () => {
  const db = makeDb({
    homepage: { blogPostSidebar: [{ type: "recent-posts", config: { maxItems: 5 } }] },
    siteConfig: {},
    compositions: { "posttype:default": stalePosttypeDoc },
  });

  const report = await reseedSidebarSurface(db, POSTTYPE_SPEC, { idFactory: makeIds(), now: () => "2026-06-18T12:00:00.000Z" });

  assert.equal(report.ran, true);
  assert.equal(report.reseeded, true);

  const doc = db.stores.compositions.get("posttype:default");
  const complementary = doc.tree.children[0];
  assert.equal(complementary.role, "complementary");
  assert.equal(complementary.variant.sticky, true);
  assert.equal(complementary.children.length, 1);
  assert.equal(complementary.children[0].type, "recent-posts");
  assert.deepEqual(complementary.children[0].config, { maxItems: 5 });
  assert.equal(doc.kind, "postType");
  assert.deepEqual(doc.target, { postType: "default" });
  assert.equal(doc.status, "published");
  assert.equal(doc.updatedAt, "2026-06-18T12:00:00.000Z");

  // Posttype gate set; listing gate untouched.
  assert.equal(db.stores.siteConfig.get("primary").migrations.posttypeReseed, true);
  assert.equal(db.stores.siteConfig.get("primary").migrations.listingReseed, undefined);
});

test("posttype: second run is a NO-OP (gate set) and does NOT clobber a later editor edit", async () => {
  const db = makeDb({
    homepage: { blogPostSidebar: [{ type: "recent-posts", config: { maxItems: 5 } }] },
    siteConfig: {},
    compositions: { "posttype:default": stalePosttypeDoc },
  });

  await reseedSidebarSurface(db, POSTTYPE_SPEC, { idFactory: makeIds(), now: () => "2026-06-18T12:00:00.000Z" });

  const editorEdit = {
    _id: "posttype:default", schemaVersion: 4, kind: "postType",
    target: { postType: "default" }, status: "published",
    tree: { block: "container", id: "c_edit", as: "stack", role: "root",
      children: [{ block: "container", id: "c_editinner", as: "stack", role: "complementary",
        variant: { sticky: true },
        children: [{ block: "section", id: "b_edit", type: "subscribe", v: 0, config: {} }] }] },
    updatedAt: "2026-06-19T00:00:00.000Z", updatedBy: "https://me.example/",
  };
  db.stores.compositions.set("posttype:default", structuredClone(editorEdit));

  const report = await reseedSidebarSurface(db, POSTTYPE_SPEC, { idFactory: makeIds(), now: () => "2026-06-20T00:00:00.000Z" });

  assert.equal(report.ran, false);
  assert.equal(report.reseeded, false);
  assert.deepEqual(db.stores.compositions.get("posttype:default"), editorEdit);
});

test("posttype: empty blogPostSidebar → gate set, NO doc written/cleared (migrator parity)", async () => {
  const db = makeDb({
    homepage: { blogPostSidebar: [] },
    siteConfig: {},
    compositions: { "posttype:default": stalePosttypeDoc },
  });

  const report = await reseedSidebarSurface(db, POSTTYPE_SPEC, { idFactory: makeIds(), now: () => "2026-06-18T12:00:00.000Z" });

  assert.equal(report.ran, true);
  assert.equal(report.reseeded, false);
  assert.deepEqual(db.stores.compositions.get("posttype:default").tree, STALE_TREE);
  assert.equal(db.stores.siteConfig.get("primary").migrations.posttypeReseed, true);
});

test("posttype: no homepageConfig doc → gate set, no-op", async () => {
  const db = makeDb({ siteConfig: {} });
  const report = await reseedSidebarSurface(db, POSTTYPE_SPEC, { idFactory: makeIds() });
  assert.equal(report.ran, true);
  assert.equal(report.reseeded, false);
  assert.equal(db.stores.compositions.size, 0);
  assert.equal(db.stores.siteConfig.get("primary").migrations.posttypeReseed, true);
});

test("posttype: pre-set gate → no-op, source untouched", async () => {
  const db = makeDb({
    homepage: { blogPostSidebar: [{ type: "recent-posts", config: { maxItems: 5 } }] },
    siteConfig: { migrations: { posttypeReseed: true } },
    compositions: { "posttype:default": stalePosttypeDoc },
  });
  const report = await reseedSidebarSurface(db, POSTTYPE_SPEC, { idFactory: makeIds() });
  assert.equal(report.ran, false);
  assert.deepEqual(db.stores.compositions.get("posttype:default").tree, STALE_TREE);
});

test("posttype: no database → no-op, does not throw", async () => {
  const report = await reseedSidebarSurface(undefined, POSTTYPE_SPEC, {});
  assert.equal(report.ran, false);
  assert.equal(report.reseeded, false);
  assert.equal(report.reason, "no database");
});

// ── Independent gates ────────────────────────────────────────────────────────

test("posttype gate is INDEPENDENT of listing gate: re-seeding posttype does NOT set listing gate", async () => {
  const db = makeDb({
    homepage: {
      blogPostSidebar: [{ type: "recent-posts", config: {} }],
      blogListingSidebar: [{ type: "categories", config: {} }],
    },
    siteConfig: {},
  });

  await reseedSidebarSurface(db, POSTTYPE_SPEC, { idFactory: makeIds() });

  const migrations = db.stores.siteConfig.get("primary").migrations;
  assert.equal(migrations.posttypeReseed, true);
  assert.equal(migrations.listingReseed, undefined);
});

test("listing gate set does NOT block a posttype re-seed (gates consumed independently)", async () => {
  const db = makeDb({
    homepage: { blogPostSidebar: [{ type: "recent-posts", config: { maxItems: 3 } }] },
    siteConfig: { migrations: { listingReseed: true } },
  });

  const report = await reseedSidebarSurface(db, POSTTYPE_SPEC, { idFactory: makeIds() });

  // The listing gate being set must NOT short-circuit the posttype re-seed.
  assert.equal(report.ran, true);
  assert.equal(report.reseeded, true);
  const doc = db.stores.compositions.get("posttype:default");
  assert.equal(doc.tree.children[0].children[0].type, "recent-posts");
  // Both gates now set; each by its own mechanism.
  const migrations = db.stores.siteConfig.get("primary").migrations;
  assert.equal(migrations.posttypeReseed, true);
  assert.equal(migrations.listingReseed, true);
});

// ── Generalized helper exercised on the listing spec (parity with wrapper) ───

test("listing spec via generalized helper OVERWRITES collection:default from blogListingSidebar", async () => {
  const db = makeDb({
    homepage: { blogListingSidebar: [{ type: "recent-posts", config: { maxItems: 7 } }] },
    siteConfig: {},
  });
  const report = await reseedSidebarSurface(db, LISTING_SPEC, { idFactory: makeIds() });
  assert.equal(report.ran, true);
  assert.equal(report.reseeded, true);
  const doc = db.stores.compositions.get("collection:default");
  assert.equal(doc.kind, "collection");
  assert.deepEqual(doc.target, { collection: "default" });
  assert.equal(doc.tree.children[0].children[0].type, "recent-posts");
  assert.equal(db.stores.siteConfig.get("primary").migrations.listingReseed, true);
});

// ── Back-compat wrapper ──────────────────────────────────────────────────────

test("reseedListingComposition wrapper still works for the listing surface", async () => {
  const db = makeDb({
    homepage: { blogListingSidebar: [{ type: "recent-posts", config: { maxItems: 7 } }] },
    siteConfig: {},
  });
  const report = await reseedListingComposition(db, { idFactory: makeIds() });
  assert.equal(report.ran, true);
  assert.equal(report.reseeded, true);
  assert.equal(db.stores.compositions.get("collection:default").kind, "collection");
  assert.equal(db.stores.siteConfig.get("primary").migrations.listingReseed, true);
});
