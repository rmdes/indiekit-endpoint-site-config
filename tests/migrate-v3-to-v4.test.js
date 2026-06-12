import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHomepageTree, migrateV3toV4 } from "../lib/storage/migrate-v3-to-v4.js";
import { BUILTIN_BLOCKS } from "../lib/presets/builtin-blocks.js";

// Deterministic id factory for assertions.
const makeIds = () => { let n = 0; return (prefix) => `${prefix}_${String(++n).padStart(6, "0")}`; };

const V3 = {
  layout: "two-column",
  hero: { enabled: true, showSocial: true, ctaText: "Read more", ctaUrl: "/about/" },
  sections: [
    { type: "recent-posts", config: { maxItems: 10 } },
    { type: "hero", config: {} },                       // v3 renderer skips these — migrator must too
    { type: "posting-activity", config: {} },
  ],
  sidebar: [{ type: "author-card", config: {} }, { type: "categories", config: {} }],
  blogListingSidebar: [{ type: "recent-posts", config: { maxItems: 5 } }],
  blogPostSidebar: [],
  footer: [{ type: "custom-html", config: { content: "<p>bye</p>" } }],
};

test("two-column with sidebar → root stack [hero, 2-1 columns [main, complementary sticky]], footer contentinfo", () => {
  const tree = buildHomepageTree(V3, makeIds());
  assert.equal(tree.block, "container");
  assert.equal(tree.role, "root");
  const [hero, columns, footer] = tree.children;
  assert.equal(hero.type, "hero");
  assert.deepEqual(hero.config, { showSocial: true, ctaText: "Read more", ctaUrl: "/about/" }); // `enabled` dropped
  assert.equal(columns.as, "columns");
  assert.deepEqual(columns.variant, { width: "default", columns: "2-1", gap: "loose" });
  const [main, complementary] = columns.children;
  assert.equal(main.role, "main");
  assert.deepEqual(main.children.map((c) => c.type), ["recent-posts", "posting-activity"]); // hero entry dropped
  assert.equal(complementary.role, "complementary");
  assert.equal(complementary.variant.sticky, true);
  assert.equal(footer.role, "contentinfo");
  assert.equal(footer.children[0].type, "custom-html");
  // Every node has an id; sections b_, containers c_ (spec §11(4))
  assert.match(hero.id, /^b_/);
  assert.match(columns.id, /^c_/);
});

test("single-column / sidebar-less / unknown layouts degrade to root stack without columns", () => {
  for (const v3 of [
    { ...V3, layout: "single-column" },
    { ...V3, layout: "two-column", sidebar: [] },
    { ...V3, layout: "mystery-meat" },
  ]) {
    const tree = buildHomepageTree(v3, makeIds());
    assert.equal(tree.children.some((c) => c.as === "columns"), false, v3.layout);
    assert.ok(tree.children.find((c) => c.role === "main"));
  }
});

test("full-width-hero maps identically to two-column (verified v3 markup identity)", () => {
  const a = JSON.stringify(buildHomepageTree({ ...V3, layout: "full-width-hero" }, makeIds()));
  const b = JSON.stringify(buildHomepageTree({ ...V3, layout: "two-column" }, makeIds()));
  assert.equal(a, b);
});

test("hero disabled → no hero block", () => {
  const tree = buildHomepageTree({ ...V3, hero: { ...V3.hero, enabled: false } }, makeIds());
  assert.equal(tree.children.some((c) => c.type === "hero"), false);
});

test("hero entry in sections[] AND hero object enabled → exactly ONE hero block (the object's)", () => {
  const tree = buildHomepageTree(V3, makeIds());
  let heroCount = 0;
  const walk = (node) => {
    if (node.block === "section" && node.type === "hero") heroCount += 1;
    for (const child of node.children || []) walk(child);
  };
  walk(tree);
  assert.equal(heroCount, 1);
  // The surviving hero is the doc-level object (carries its config), not the
  // empty-config sections[] entry.
  assert.deepEqual(tree.children[0].config, { showSocial: true, ctaText: "Read more", ctaUrl: "/about/" });
});

test("every node carries an id; b_ for sections, c_ for containers — no s_/w_ split", () => {
  const tree = buildHomepageTree(V3, makeIds());
  const ids = [];
  const walk = (node) => {
    ids.push([node.block, node.id]);
    for (const child of node.children || []) walk(child);
  };
  walk(tree);
  assert.ok(ids.length > 0);
  for (const [block, id] of ids) {
    assert.equal(typeof id, "string");
    assert.match(id, block === "section" ? /^b_/ : /^c_/);
  }
  // All ids unique within the tree
  assert.equal(new Set(ids.map(([, id]) => id)).size, ids.length);
});

test("entries with missing/null config map to empty config; typeless entries dropped", () => {
  const tree = buildHomepageTree({
    ...V3,
    hero: { enabled: false },
    sections: [
      { type: "recent-posts" },
      { type: "posting-activity", config: null },
      { config: { maxItems: 3 } },          // no type → dropped
      null,                                  // garbage → dropped
    ],
    sidebar: [],
    footer: [],
  }, makeIds());
  const [main] = tree.children;
  assert.equal(main.role, "main");
  assert.deepEqual(main.children.map((c) => c.type), ["recent-posts", "posting-activity"]);
  assert.deepEqual(main.children[0].config, {});
  assert.deepEqual(main.children[1].config, {});
});

test("empty footer → no contentinfo container", () => {
  const tree = buildHomepageTree({ ...V3, footer: [] }, makeIds());
  assert.equal(tree.children.some((c) => c.role === "contentinfo"), false);
});

test("buildHomepageTree is throw-free on a hostile/empty v3 doc", () => {
  for (const v3 of [{}, { sections: "nope", sidebar: 42, footer: null, hero: "x" }]) {
    const tree = buildHomepageTree(v3, makeIds());
    assert.equal(tree.role, "root");
    assert.ok(tree.children.find((c) => c.role === "main"));
  }
});

// ---- the full migrator over a stubbed db ----
function makeDb(homepageDoc) {
  const stores = { homepageConfig: new Map(), compositions: new Map() };
  if (homepageDoc) stores.homepageConfig.set("homepage", { _id: "homepage", ...homepageDoc });
  return {
    stores,
    collection(name) {
      const store = stores[name] ?? (stores[name] = new Map());
      return {
        async findOne({ _id }) { return store.get(_id) || null; },
        async replaceOne({ _id }, doc, opts) { store.set(_id, doc); },
        async countDocuments() { return store.size; },
      };
    },
  };
}

test("dryRun computes docs, validates them, writes NOTHING", async () => {
  const db = makeDb(V3);
  const { docs, report } = await migrateV3toV4(db, BUILTIN_BLOCKS, { dryRun: true });
  assert.equal(db.stores.compositions.size, 0);
  const ids = docs.map((d) => d._id).sort();
  assert.deepEqual(ids, ["collection:default", "homepage"]); // empty blogPostSidebar → no posttype doc
  assert.equal(report.valid, true);
  for (const doc of docs) {
    assert.equal(doc.schemaVersion, 4);
    assert.equal(doc.status, "published");
    assert.match(doc.updatedAt, /^\d{4}-/); // ISO string
    assert.equal("updatedBy" in doc, true);
  }
});

test("non-dry seeds compositions but NEVER overwrites an existing one (dual-running, edit-safe)", async () => {
  const db = makeDb(V3);
  await migrateV3toV4(db, BUILTIN_BLOCKS, { dryRun: false });
  assert.equal(db.stores.compositions.size, 2);
  const before = structuredClone(db.stores.compositions.get("homepage"));
  // Simulate a later (Phase 4 editor) edit, then re-run — must not clobber.
  db.stores.compositions.get("homepage").tree.children = [];
  await migrateV3toV4(db, BUILTIN_BLOCKS, { dryRun: false });
  assert.deepEqual(db.stores.compositions.get("homepage").tree.children, []);
  assert.notDeepEqual(db.stores.compositions.get("homepage"), before);
});

test("v3 source missing → no-op with report.skipped", async () => {
  const db = makeDb(null);
  const { report } = await migrateV3toV4(db, BUILTIN_BLOCKS, { dryRun: false });
  assert.equal(report.skipped, true);
  assert.equal(db.stores.compositions.size, 0);
});

test("the migrated homepage validates against the real built-in catalog", async () => {
  const db = makeDb(V3);
  const { docs, report } = await migrateV3toV4(db, BUILTIN_BLOCKS, { dryRun: true });
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.ok(docs.length >= 1);
});

test("migrator persists RAW configs — no schema defaults materialized (gate, not transformer)", async () => {
  const db = makeDb(V3);
  await migrateV3toV4(db, BUILTIN_BLOCKS, { dryRun: false });
  const homepage = db.stores.compositions.get("homepage");
  const [, columns] = homepage.tree.children;
  const [main] = columns.children;
  const recentPosts = main.children.find((c) => c.type === "recent-posts");
  // The recent-posts schema defaults postTypes — RAW persistence must NOT add it.
  assert.deepEqual(recentPosts.config, { maxItems: 10 });
  const postingActivity = main.children.find((c) => c.type === "posting-activity");
  // posting-activity defaults title/limit — RAW persistence must NOT add them.
  assert.deepEqual(postingActivity.config, {});
});

test("the v3 homepageConfig doc is never touched (dual-running)", async () => {
  const db = makeDb(V3);
  const before = structuredClone(db.stores.homepageConfig.get("homepage"));
  await migrateV3toV4(db, BUILTIN_BLOCKS, { dryRun: false });
  await migrateV3toV4(db, BUILTIN_BLOCKS, { dryRun: false });
  assert.deepEqual(db.stores.homepageConfig.get("homepage"), before);
  assert.equal(db.stores.homepageConfig.size, 1);
});

test("custom idFactory injection works (deterministic ids end-to-end)", async () => {
  const db = makeDb(V3);
  const { docs } = await migrateV3toV4(db, BUILTIN_BLOCKS, {
    dryRun: true,
    idFactory: makeIds(),
  });
  const homepage = docs.find((d) => d._id === "homepage");
  // First emitted node is the hero section → b_000001 with the shared counter.
  assert.equal(homepage.tree.children[0].id, "b_000001");
  const allIds = [];
  const walk = (node) => {
    allIds.push(node.id);
    for (const child of node.children || []) walk(child);
  };
  for (const doc of docs) walk(doc.tree);
  assert.equal(new Set(allIds).size, allIds.length); // factory shared across docs, ids unique
});

test("validation failure → report.valid false, errors reported, non-dry writes NOTHING (no partial seed)", async () => {
  // Poison beyond schema bounds: recent-posts maxItems maximum is 50.
  const poisoned = {
    ...V3,
    sections: [{ type: "recent-posts", config: { maxItems: 999 } }, ...V3.sections.slice(1)],
  };
  const db = makeDb(poisoned);
  const { docs, report } = await migrateV3toV4(db, BUILTIN_BLOCKS, { dryRun: false });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((e) => e.startsWith("homepage:")));
  assert.ok(docs.length >= 1); // docs still returned for inspection
  // Even the VALID sidecar doc (collection:default) must not seed — no partial state.
  assert.equal(db.stores.compositions.size, 0);
});

test("blogPostSidebar non-empty → posttype:default doc with kind/target", async () => {
  const db = makeDb({ ...V3, blogPostSidebar: [{ type: "author-card-compact", config: {} }] });
  const { docs, report } = await migrateV3toV4(db, BUILTIN_BLOCKS, { dryRun: true });
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  const postType = docs.find((d) => d._id === "posttype:default");
  assert.ok(postType);
  assert.equal(postType.kind, "postType");
  assert.deepEqual(postType.target, { postType: "default" });
  const listing = docs.find((d) => d._id === "collection:default");
  assert.equal(listing.kind, "collection");
  assert.deepEqual(listing.target, { collection: "default" });
  // Sidebar surface trees: root stack wrapping a sticky complementary stack.
  assert.equal(postType.tree.role, "root");
  const [complementary] = postType.tree.children;
  assert.equal(complementary.role, "complementary");
  assert.equal(complementary.variant.sticky, true);
  assert.equal(complementary.children[0].type, "author-card-compact");
});

test("partial pre-existence → only missing docs seed; report.skippedExisting lists the rest", async () => {
  const db = makeDb(V3);
  db.stores.compositions.set("homepage", { _id: "homepage", sentinel: true });
  const { report } = await migrateV3toV4(db, BUILTIN_BLOCKS, { dryRun: false });
  assert.deepEqual(report.skippedExisting, ["homepage"]);
  assert.deepEqual(report.seeded, ["collection:default"]);
  assert.deepEqual(db.stores.compositions.get("homepage"), { _id: "homepage", sentinel: true });
  assert.ok(db.stores.compositions.get("collection:default"));
});

test("dropped sections[] hero entries are reported as a warning", async () => {
  const db = makeDb(V3);
  const { report } = await migrateV3toV4(db, BUILTIN_BLOCKS, { dryRun: true });
  assert.ok(report.warnings.some((w) => /hero/.test(w) && /dropped|skip/i.test(w)));
});

test("db errors propagate to the caller (no silent swallow)", async () => {
  const db = {
    collection() {
      return {
        async findOne() { throw new Error("mongo down"); },
      };
    },
  };
  await assert.rejects(() => migrateV3toV4(db, BUILTIN_BLOCKS, { dryRun: true }), /mongo down/);
});
