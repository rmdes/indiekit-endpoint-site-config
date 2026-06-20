import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cvPageConfigToTree,
  migrateCvPage,
  DEFAULT_CV_PAGE_CONFIG,
} from "../lib/storage/migrate-cv-page.js";
import { validateComposition } from "../lib/validators/composition.js";

// Phase 7 Task 3 — seed a `page:cv` composition from the retired CV plugin's
// `cvPageConfig` layout. Transform reuses the tested `buildHomepageTree`; the
// seed reuses the create-only, draft-only `createPage` (so a seeded page does
// NOT emit /cv/ until published — the /cv collision guard).

const makeIds = () => {
  let n = 0;
  return (p) => `${p}_${String(++n).padStart(6, "0")}`;
};

// ---- pure transform ----

test("cvPageConfigToTree(DEFAULT): root stack with hero + main holding the 6 work sections", () => {
  const tree = cvPageConfigToTree(DEFAULT_CV_PAGE_CONFIG, makeIds());
  assert.equal(tree.block, "container");
  assert.equal(tree.role, "root");
  const hero = tree.children.find((c) => c.type === "hero");
  assert.ok(hero, "hero section present (hero.enabled)");
  assert.deepEqual(hero.config, { showSocial: true });
  const main = tree.children.find((c) => c.role === "main");
  assert.ok(main);
  assert.deepEqual(
    main.children.map((c) => c.type),
    ["cv-experience-work", "cv-skills-work", "cv-projects-work", "cv-education-work", "cv-languages", "cv-interests-work"],
  );
});

test("cvPageConfigToTree(null) falls back to the default layout", () => {
  const tree = cvPageConfigToTree(null, makeIds());
  assert.equal(tree.children.find((c) => c.role === "main").children.length, 6);
});

test("cvPageConfigToTree maps a custom stored layout (sections + two-column sidebar, hero off)", () => {
  const cfg = {
    layout: "two-column",
    hero: { enabled: false },
    sections: [{ type: "cv-experience", config: { maxItems: 5 } }],
    sidebar: [{ type: "cv-languages", config: {} }],
    footer: [],
  };
  const tree = cvPageConfigToTree(cfg, makeIds());
  assert.ok(!tree.children.some((c) => c.type === "hero"), "no hero when disabled");
  const cols = tree.children.find((c) => c.as === "columns");
  assert.ok(cols, "two-column + sidebar → columns container");
  assert.equal(cols.children[0].children[0].type, "cv-experience");
  assert.deepEqual(cols.children[0].children[0].config, { maxItems: 5 });
  assert.equal(cols.children[1].children[0].type, "cv-languages");
});

test("produced tree validates against validateComposition (kind:page)", () => {
  const CATALOG = [
    { id: "hero", multiple: false, schema: { type: "object", additionalProperties: false, properties: { showSocial: { type: "boolean" } } } },
    ...["cv-experience-work", "cv-skills-work", "cv-projects-work", "cv-education-work", "cv-languages", "cv-interests-work"].map((id) => ({
      id,
      multiple: false,
      schema: { type: "object", additionalProperties: false, properties: {} },
    })),
  ];
  const doc = {
    _id: "page:cv",
    schemaVersion: 4,
    kind: "page",
    status: "draft",
    target: { route: "/cv/", title: "CV" },
    tree: cvPageConfigToTree(DEFAULT_CV_PAGE_CONFIG, makeIds()),
  };
  const result = validateComposition(doc, CATALOG);
  assert.equal(result.ok, true, (result.errors || []).join("; "));
});

// ---- migration (in-memory mock db emulating $setOnInsert upsert) ----

function mockDb(seed = {}) {
  const cols = {};
  const get = (name) => (cols[name] ??= new Map(Object.entries(seed[name] || {})));
  return {
    _cols: cols,
    collection(name) {
      const m = get(name);
      return {
        async findOne(filter) {
          return m.get(filter._id) ?? null;
        },
        async updateOne(filter, update, opts) {
          const id = filter._id;
          if (m.has(id)) return { matchedCount: 1, upsertedCount: 0 };
          if (opts?.upsert) {
            m.set(id, { _id: id, ...(update.$setOnInsert || {}) });
            return { matchedCount: 0, upsertedCount: 1 };
          }
          return { matchedCount: 0, upsertedCount: 0 };
        },
      };
    },
  };
}

test("migrateCvPage seeds a DRAFT page:cv (no published tree → no /cv collision)", async () => {
  const db = mockDb({ cvPageConfig: { "cv-page": { _id: "cv-page", ...DEFAULT_CV_PAGE_CONFIG } } });
  const r = await migrateCvPage(db, { newId: makeIds() });
  assert.equal(r.seeded, true);
  const doc = db._cols.compositions.get("page:cv");
  assert.ok(doc, "page:cv inserted");
  assert.equal(doc.kind, "page");
  assert.equal(doc.status, "draft");
  assert.ok(doc.draftTree, "draftTree present");
  assert.ok(!doc.tree, "NO published tree");
  assert.deepEqual(doc.target, { route: "/cv/", title: "CV" });
});

test("migrateCvPage is seed-if-absent: no-op when page:cv already exists", async () => {
  const existing = { _id: "page:cv", kind: "page", status: "published", tree: { block: "container" } };
  const db = mockDb({ compositions: { "page:cv": existing } });
  const r = await migrateCvPage(db, { newId: makeIds() });
  assert.equal(r.seeded, false);
  assert.equal(r.existed, true);
  assert.deepEqual(db._cols.compositions.get("page:cv"), existing, "untouched");
});

test("migrateCvPage uses the default layout when no cvPageConfig doc exists", async () => {
  const db = mockDb({});
  const r = await migrateCvPage(db, { newId: makeIds() });
  assert.equal(r.usedDefault, true);
  assert.equal(r.seeded, true);
  assert.equal(db._cols.compositions.get("page:cv").draftTree.children.find((c) => c.role === "main").children.length, 6);
});

test("migrateCvPage dryRun: returns the tree, writes nothing", async () => {
  const db = mockDb({ cvPageConfig: { "cv-page": { _id: "cv-page", ...DEFAULT_CV_PAGE_CONFIG } } });
  const r = await migrateCvPage(db, { dryRun: true, newId: makeIds() });
  assert.equal(r.seeded, false);
  assert.ok(r.tree, "tree returned for inspection");
  assert.equal(db._cols.compositions, undefined, "no write on dryRun");
});

test("migrateCvPage: no db → safe no-op", async () => {
  assert.deepEqual(await migrateCvPage(null), { ok: false, reason: "no-db" });
});
