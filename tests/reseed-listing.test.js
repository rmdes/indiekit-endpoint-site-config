import { test } from "node:test";
import assert from "node:assert/strict";
import { reseedListingComposition } from "../lib/storage/reseed-sidebar-surface.js";

// Deterministic id factory for assertions.
const makeIds = () => { let n = 0; return (prefix) => `${prefix}_${String(++n).padStart(6, "0")}`; };

/**
 * Stub db mirroring tests/migrate-v3-to-v4.test.js. siteConfig + homepageConfig
 * + compositions stores; replaceOne refuses a non-upsert miss (catches bad calls).
 */
function makeDb({ homepage, siteConfig, listingComposition } = {}) {
  const stores = {
    siteConfig: new Map(),
    homepageConfig: new Map(),
    compositions: new Map(),
  };
  if (homepage) stores.homepageConfig.set("homepage", { _id: "homepage", ...homepage });
  if (siteConfig) stores.siteConfig.set("primary", { _id: "primary", ...siteConfig });
  if (listingComposition) stores.compositions.set("collection:default", { _id: "collection:default", ...listingComposition });
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
              // Support dotted paths (e.g. "migrations.listingReseed").
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

const STALE_TREE = {
  block: "container", id: "c_stale", as: "stack", role: "root",
  children: [{
    block: "container", id: "c_staleinner", as: "stack", role: "complementary",
    variant: { sticky: true },
    children: [{ block: "section", id: "b_stale", type: "categories", v: 0, config: {} }],
  }],
};

const STALE_LISTING_DOC = {
  schemaVersion: 4, kind: "collection", target: { collection: "default" },
  status: "published", tree: STALE_TREE,
  updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "migrate-v3-to-v4",
};

test("first run OVERWRITES collection:default tree from current blogListingSidebar; gate set", async () => {
  const db = makeDb({
    homepage: { blogListingSidebar: [{ type: "recent-posts", config: { maxItems: 7 } }] },
    siteConfig: {},
    listingComposition: STALE_LISTING_DOC,
  });

  const report = await reseedListingComposition(db, { idFactory: makeIds(), now: () => "2026-06-18T12:00:00.000Z" });

  assert.equal(report.ran, true);
  assert.equal(report.reseeded, true);

  const doc = db.stores.compositions.get("collection:default");
  // The stale "categories" section is gone; the current "recent-posts" is in.
  const complementary = doc.tree.children[0];
  assert.equal(complementary.role, "complementary");
  assert.equal(complementary.variant.sticky, true);
  assert.equal(complementary.children.length, 1);
  assert.equal(complementary.children[0].type, "recent-posts");
  assert.deepEqual(complementary.children[0].config, { maxItems: 7 });
  assert.equal(doc.status, "published");
  assert.equal(doc.updatedAt, "2026-06-18T12:00:00.000Z");

  // Gate persisted on the siteConfig singleton.
  assert.equal(db.stores.siteConfig.get("primary").migrations.listingReseed, true);
});

test("second run is a NO-OP (gate set) and does NOT clobber a later listing-editor edit", async () => {
  const db = makeDb({
    homepage: { blogListingSidebar: [{ type: "recent-posts", config: { maxItems: 7 } }] },
    siteConfig: {},
    listingComposition: STALE_LISTING_DOC,
  });

  await reseedListingComposition(db, { idFactory: makeIds(), now: () => "2026-06-18T12:00:00.000Z" });

  // Simulate the operator editing the listing surface AFTER cutover.
  const editorEdit = {
    _id: "collection:default", schemaVersion: 4, kind: "collection",
    target: { collection: "default" }, status: "published",
    tree: { block: "container", id: "c_edit", as: "stack", role: "root",
      children: [{ block: "container", id: "c_editinner", as: "stack", role: "complementary",
        variant: { sticky: true },
        children: [{ block: "section", id: "b_edit", type: "subscribe", v: 0, config: {} }] }] },
    updatedAt: "2026-06-19T00:00:00.000Z", updatedBy: "https://me.example/",
  };
  db.stores.compositions.set("collection:default", structuredClone(editorEdit));

  const report = await reseedListingComposition(db, { idFactory: makeIds(), now: () => "2026-06-20T00:00:00.000Z" });

  assert.equal(report.ran, false); // gate already set → no-op
  assert.equal(report.reseeded, false);
  // The editor's edit survives untouched — the second boot did NOT clobber it.
  assert.deepEqual(db.stores.compositions.get("collection:default"), editorEdit);
});

test("empty blogListingSidebar → gate set, NO doc written/cleared (migrator parity)", async () => {
  const db = makeDb({
    homepage: { blogListingSidebar: [] },
    siteConfig: {},
    listingComposition: STALE_LISTING_DOC,
  });

  const report = await reseedListingComposition(db, { idFactory: makeIds(), now: () => "2026-06-18T12:00:00.000Z" });

  assert.equal(report.ran, true);
  assert.equal(report.reseeded, false); // empty → no overwrite
  // The pre-existing doc is left as-is (no clobber to empty, matching the
  // migrator which creates NO doc for an empty sidebar).
  assert.deepEqual(db.stores.compositions.get("collection:default").tree, STALE_TREE);
  // Gate still set so it never runs again.
  assert.equal(db.stores.siteConfig.get("primary").migrations.listingReseed, true);
});

test("gate flag persists across runs (idempotent by construction)", async () => {
  const db = makeDb({
    homepage: { blogListingSidebar: [{ type: "recent-posts", config: {} }] },
    siteConfig: {},
  });
  await reseedListingComposition(db, { idFactory: makeIds() });
  const afterFirst = db.stores.siteConfig.get("primary").migrations.listingReseed;
  await reseedListingComposition(db, { idFactory: makeIds() });
  const afterSecond = db.stores.siteConfig.get("primary").migrations.listingReseed;
  assert.equal(afterFirst, true);
  assert.equal(afterSecond, true);
});

test("no homepageConfig doc → gate set, no-op (nothing to re-seed from)", async () => {
  const db = makeDb({ siteConfig: {} });
  const report = await reseedListingComposition(db, { idFactory: makeIds() });
  assert.equal(report.ran, true);
  assert.equal(report.reseeded, false);
  assert.equal(db.stores.compositions.size, 0);
  assert.equal(db.stores.siteConfig.get("primary").migrations.listingReseed, true);
});

test("pre-set gate (no siteConfig migrations object yet exists) → still no-op when true", async () => {
  const db = makeDb({
    homepage: { blogListingSidebar: [{ type: "recent-posts", config: { maxItems: 7 } }] },
    siteConfig: { migrations: { listingReseed: true } },
    listingComposition: STALE_LISTING_DOC,
  });
  const report = await reseedListingComposition(db, { idFactory: makeIds() });
  assert.equal(report.ran, false);
  assert.deepEqual(db.stores.compositions.get("collection:default").tree, STALE_TREE);
});

test("no database → no-op, does not throw", async () => {
  const report = await reseedListingComposition(undefined, {});
  assert.equal(report.ran, false);
  assert.equal(report.reseeded, false);
});
