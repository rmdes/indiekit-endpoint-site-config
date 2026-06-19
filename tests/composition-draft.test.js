import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getEditorState,
  saveDraft,
  publishDraft,
  discardDraft,
  createDraftFromTree,
  createPage,
  listPages,
  deleteComposition,
} from "../lib/storage/composition-draft.js";
import { BUILTIN_BLOCKS } from "../lib/presets/builtin-blocks.js";

// In-memory db stub following the migrator tests' makeDb conventions
// (tests/migrate-v3-to-v4.test.js), extended with updateOne mirroring the
// real driver's $set/$unset semantics and {matchedCount} result shape.
// replaceOne throws on purpose: drafts MUST use atomic field updates (the
// TOCTOU note in migrate-v3-to-v4.js) — any whole-doc replace is a bug.
function makeDb(docs = []) {
  const store = new Map(docs.map((doc) => [doc._id, structuredClone(doc)]));
  const calls = [];
  return {
    store,
    calls,
    collection(name) {
      return {
        async findOne({ _id }) {
          calls.push(["findOne", name, _id]);
          return store.get(_id) ?? null;
        },
        // Equality-filter find (used by listPages). Supports {kind, status}.
        find(filter = {}) {
          const matches = (doc) =>
            Object.entries(filter).every(([key, value]) => doc[key] === value);
          const docs = [...store.values()].filter(matches).map((d) => structuredClone(d));
          return { async toArray() { return docs; } };
        },
        async deleteOne({ _id }) {
          calls.push(["deleteOne", name, _id]);
          const existed = store.delete(_id);
          return { deletedCount: existed ? 1 : 0 };
        },
        // Filter-aware (equality + {$exists}) with upsert/$setOnInsert
        // support — mirrors the driver semantics the publish conflict guard
        // and createDraftFromTree rely on.
        async updateOne(filter, update, options = {}) {
          calls.push(["updateOne", name, filter._id, structuredClone(update)]);
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
              for (const [key, value] of Object.entries(update.$setOnInsert ?? {})) {
                inserted[key] = value;
              }
              for (const [key, value] of Object.entries(update.$set ?? {})) {
                inserted[key] = value;
              }
              store.set(filter._id, inserted);
              return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
            }
            return { matchedCount: 0, modifiedCount: 0 };
          }
          for (const [key, value] of Object.entries(update.$set ?? {})) doc[key] = value;
          for (const key of Object.keys(update.$unset ?? {})) delete doc[key];
          return { matchedCount: 1, modifiedCount: 1 };
        },
        async replaceOne() {
          throw new Error("replaceOne forbidden — drafts must use atomic updateOne");
        },
      };
    },
  };
}

const validTree = (sectionConfig = { maxItems: 10 }) => ({
  block: "container", id: "c_root", as: "stack", role: "root",
  children: [{
    block: "container", id: "c_main", as: "stack", role: "main",
    children: [{
      block: "section", id: "b_1", type: "recent-posts", v: 0, config: sectionConfig,
    }],
  }],
});

const makeDoc = (extra = {}) => ({
  _id: "homepage",
  schemaVersion: 4,
  kind: "homepage",
  status: "published",
  tree: validTree(),
  updatedAt: "2026-06-01T00:00:00.000Z",
  updatedBy: "migrate-v3-to-v4",
  ...extra,
});

const NOW = "2026-06-12T10:00:00.000Z";
const now = () => NOW;

// ---- getEditorState ----

test("getEditorState: missing doc → null", async () => {
  assert.equal(await getEditorState(makeDb(), "homepage"), null);
});

test("getEditorState: published-only doc → published tree, isDraft false", async () => {
  const db = makeDb([makeDoc()]);
  const state = await getEditorState(db, "homepage");
  assert.equal(state.isDraft, false);
  assert.deepEqual(state.tree, validTree());
  assert.equal(state.doc._id, "homepage");
});

test("getEditorState: draft present → draft tree wins, isDraft true", async () => {
  const draft = validTree({ maxItems: 3 });
  const db = makeDb([makeDoc({ draftTree: draft, draftUpdatedAt: NOW })]);
  const state = await getEditorState(db, "homepage");
  assert.equal(state.isDraft, true);
  assert.deepEqual(state.tree, draft);
  assert.deepEqual(state.doc.tree, validTree()); // published tree still on the doc
});

// ---- saveDraft ----

test("saveDraft sets draftTree + draftUpdatedAt atomically, published tree untouched", async () => {
  const db = makeDb([makeDoc()]);
  const draft = validTree({ maxItems: 5 });
  const result = await saveDraft(db, "homepage", draft, { now });
  assert.deepEqual(result, { ok: true });
  const stored = db.store.get("homepage");
  assert.deepEqual(stored.draftTree, draft);
  assert.equal(stored.draftUpdatedAt, NOW);
  assert.deepEqual(stored.tree, validTree()); // published state untouched
  assert.equal(stored.updatedAt, "2026-06-01T00:00:00.000Z");
  // Atomic field update — exactly one updateOne with ONLY the draft fields.
  const updates = db.calls.filter(([op]) => op === "updateOne");
  assert.equal(updates.length, 1);
  assert.deepEqual(Object.keys(updates[0][3].$set).sort(), ["draftTree", "draftUpdatedAt"]);
});

test("saveDraft on a missing doc → not-found, nothing created", async () => {
  const db = makeDb();
  const result = await saveDraft(db, "homepage", validTree(), { now });
  assert.deepEqual(result, { ok: false, error: "not-found" });
  assert.equal(db.store.size, 0);
});

test("saveDraft → getEditorState round-trips the draft", async () => {
  const db = makeDb([makeDoc()]);
  const draft = validTree({ maxItems: 7 });
  await saveDraft(db, "homepage", draft, { now });
  const state = await getEditorState(db, "homepage");
  assert.equal(state.isDraft, true);
  assert.deepEqual(state.tree, draft);
});

// ---- publishDraft ----

test("publishDraft: valid draft → tree promoted, draft fields unset, stamps applied", async () => {
  const draft = validTree({ maxItems: 5 });
  const db = makeDb([makeDoc({ draftTree: draft, draftUpdatedAt: "2026-06-11T00:00:00.000Z" })]);
  const artifacts = [];
  const result = await publishDraft(db, "homepage", BUILTIN_BLOCKS, {
    writeArtifact: async (doc) => artifacts.push(doc),
    now,
  });
  assert.deepEqual(result, { ok: true });
  const stored = db.store.get("homepage");
  assert.deepEqual(stored.tree, draft);
  assert.equal("draftTree" in stored, false);
  assert.equal("draftUpdatedAt" in stored, false);
  assert.equal(stored.status, "published");
  assert.equal(stored.updatedAt, NOW);
  assert.equal(stored.updatedBy, "design-editor"); // default stamp
  assert.equal(artifacts.length, 1);
});

test("publishDraft: the artifact doc carries the candidate tree and NO draft fields", async () => {
  const draft = validTree({ maxItems: 5 });
  const db = makeDb([makeDoc({ draftTree: draft, draftUpdatedAt: NOW })]);
  const artifacts = [];
  await publishDraft(db, "homepage", BUILTIN_BLOCKS, {
    writeArtifact: async (doc) => artifacts.push(doc),
    now,
    updatedBy: "tester",
  });
  const [artifact] = artifacts;
  assert.deepEqual(artifact.tree, draft);
  assert.equal("draftTree" in artifact, false);
  assert.equal("draftUpdatedAt" in artifact, false);
  assert.equal(artifact.status, "published");
  assert.equal(artifact.updatedAt, NOW);
  assert.equal(artifact.updatedBy, "tester"); // option override respected
  assert.equal(artifact._id, "homepage"); // writeCompositionJson needs _id for the file name
});

test("publishDraft: invalid draft → {ok:false, errors}, NO db write, NO artifact, draft retained", async () => {
  const bad = validTree({ maxItems: 999 }); // recent-posts maximum is 50
  const db = makeDb([makeDoc({ draftTree: bad, draftUpdatedAt: NOW })]);
  const artifacts = [];
  const result = await publishDraft(db, "homepage", BUILTIN_BLOCKS, {
    writeArtifact: async (doc) => artifacts.push(doc),
    now,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.equal(artifacts.length, 0);
  assert.equal(db.calls.some(([op]) => op === "updateOne"), false);
  const stored = db.store.get("homepage");
  assert.deepEqual(stored.draftTree, bad); // draft kept for the editor to fix
  assert.deepEqual(stored.tree, validTree()); // published state untouched
});

test("publishDraft: gate is STRICT — unknown config keys in the draft are errors", async () => {
  const sneaky = validTree({ maxItems: 5, bogus: true });
  const db = makeDb([makeDoc({ draftTree: sneaky, draftUpdatedAt: NOW })]);
  const result = await publishDraft(db, "homepage", BUILTIN_BLOCKS, {
    writeArtifact: async () => {},
    now,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /bogus/.test(e)), JSON.stringify(result.errors));
});

test("publishDraft without a draft republishes the stored tree", async () => {
  const db = makeDb([makeDoc()]);
  const artifacts = [];
  const result = await publishDraft(db, "homepage", BUILTIN_BLOCKS, {
    writeArtifact: async (doc) => artifacts.push(doc),
    now,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(artifacts[0].tree, validTree());
  assert.equal(db.store.get("homepage").updatedAt, NOW);
});

test("publishDraft: missing doc → not-found, no writes", async () => {
  const db = makeDb();
  const artifacts = [];
  const result = await publishDraft(db, "homepage", BUILTIN_BLOCKS, {
    writeArtifact: async (doc) => artifacts.push(doc),
    now,
  });
  assert.deepEqual(result, { ok: false, error: "not-found" });
  assert.equal(artifacts.length, 0);
});

test("publishDraft: artifact writer errors propagate (db already updated; boot self-heals)", async () => {
  const db = makeDb([makeDoc({ draftTree: validTree({ maxItems: 5 }), draftUpdatedAt: NOW })]);
  await assert.rejects(
    () => publishDraft(db, "homepage", BUILTIN_BLOCKS, {
      writeArtifact: async () => { throw new Error("disk full"); },
      now,
    }),
    /disk full/,
  );
  // The db promotion happened before the artifact failure (Phase 3 posture:
  // boot rewrites artifacts from MongoDB, so db-ahead-of-disk self-heals).
  assert.deepEqual(db.store.get("homepage").tree, validTree({ maxItems: 5 }));
});

// ---- discardDraft ----

test("discardDraft removes both draft fields, keeps published state", async () => {
  const db = makeDb([makeDoc({ draftTree: validTree({ maxItems: 3 }), draftUpdatedAt: NOW })]);
  const result = await discardDraft(db, "homepage");
  assert.deepEqual(result, { ok: true });
  const stored = db.store.get("homepage");
  assert.equal("draftTree" in stored, false);
  assert.equal("draftUpdatedAt" in stored, false);
  assert.deepEqual(stored.tree, validTree());
});

test("discardDraft is idempotent (no draft / no doc)", async () => {
  assert.deepEqual(await discardDraft(makeDb([makeDoc()]), "homepage"), { ok: true });
  assert.deepEqual(await discardDraft(makeDb(), "homepage"), { ok: true });
});

// ---- publish concurrency guard ----

test("publishDraft: a draft saved between read and promote → conflict, racing draft survives", async () => {
  const db = makeDb([
    makeDoc({ draftTree: validTree({ maxItems: 5 }), draftUpdatedAt: "2026-06-12T09:00:00.000Z" }),
  ]);
  // Wrap findOne so the racing editor's saveDraft lands right after our
  // read — publishDraft then promotes against a stale draftUpdatedAt.
  const racingDraft = validTree({ maxItems: 9 });
  const racing = {
    collection(name) {
      const col = db.collection(name);
      return {
        ...col,
        async findOne(query) {
          const doc = await col.findOne(query);
          const snapshot = structuredClone(doc);
          if (doc) await saveDraft(db, "homepage", racingDraft, { now: () => "2026-06-12T09:00:01.000Z" });
          return snapshot;
        },
      };
    },
  };
  const artifacts = [];
  const result = await publishDraft(racing, "homepage", BUILTIN_BLOCKS, {
    writeArtifact: async (doc) => artifacts.push(doc),
    now,
  });
  assert.deepEqual(result, { ok: false, error: "conflict" });
  assert.equal(artifacts.length, 0); // nothing published
  const stored = db.store.get("homepage");
  assert.deepEqual(stored.draftTree, racingDraft); // racing draft NOT clobbered
  assert.deepEqual(stored.tree, validTree()); // published tree untouched
});

test("publishDraft: draft-less republish passes the {$exists:false} guard", async () => {
  // The conflict filter must still match docs that never had a draft.
  const db = makeDb([makeDoc()]);
  const result = await publishDraft(db, "homepage", BUILTIN_BLOCKS, {
    writeArtifact: async () => {},
    now,
  });
  assert.deepEqual(result, { ok: true });
});

// ---- createDraftFromTree (apply-recipe's create path) ----

test("createDraftFromTree creates a draft-only doc via atomic upsert (no published tree)", async () => {
  const db = makeDb();
  const tree = validTree({ maxItems: 4 });
  const result = await createDraftFromTree(db, "homepage", "homepage", tree, { now });
  assert.deepEqual(result, { ok: true });
  const stored = db.store.get("homepage");
  assert.equal(stored.schemaVersion, 4);
  assert.equal(stored.kind, "homepage");
  assert.equal(stored.status, "draft");
  assert.deepEqual(stored.draftTree, tree);
  assert.equal(stored.draftUpdatedAt, NOW);
  assert.equal("tree" in stored, false); // nothing published until publishDraft
  const state = await getEditorState(db, "homepage");
  assert.equal(state.isDraft, true);
  assert.deepEqual(state.tree, tree);
});

test("createDraftFromTree on an EXISTING doc only replaces the draft ($setOnInsert inert)", async () => {
  const db = makeDb([makeDoc({ draftTree: validTree({ maxItems: 2 }), draftUpdatedAt: "old" })]);
  const tree = validTree({ maxItems: 4 });
  const result = await createDraftFromTree(db, "homepage", "homepage", tree, { now });
  assert.deepEqual(result, { ok: true });
  const stored = db.store.get("homepage");
  assert.deepEqual(stored.draftTree, tree);
  assert.equal(stored.draftUpdatedAt, NOW);
  assert.equal(stored.status, "published"); // $setOnInsert must not fire on match
  assert.deepEqual(stored.tree, validTree());
  assert.equal(stored.updatedAt, "2026-06-01T00:00:00.000Z");
});

test("createDraftFromTree → publishDraft promotes the first-ever publish", async () => {
  const db = makeDb();
  const tree = validTree({ maxItems: 4 });
  await createDraftFromTree(db, "homepage", "homepage", tree, { now });
  const artifacts = [];
  const result = await publishDraft(db, "homepage", BUILTIN_BLOCKS, {
    writeArtifact: async (doc) => artifacts.push(doc),
    now,
  });
  assert.deepEqual(result, { ok: true });
  const stored = db.store.get("homepage");
  assert.deepEqual(stored.tree, tree);
  assert.equal(stored.status, "published");
  assert.equal("draftTree" in stored, false);
  assert.deepEqual(artifacts[0].tree, tree);
});

// ---- createPage (atomic create-only — pages create path, D6) ----

const pageTarget = (slug = "about") => ({ route: `/${slug}/`, title: "About me" });

test("createPage inserts a draft-only page doc with target when none exists", async () => {
  const db = makeDb();
  const tree = validTree({ maxItems: 4 });
  const result = await createPage(db, "about", pageTarget("about"), tree, { now });
  assert.deepEqual(result, { ok: true });
  const stored = db.store.get("page:about");
  assert.equal(stored.schemaVersion, 4);
  assert.equal(stored.kind, "page");
  assert.equal(stored.status, "draft");
  assert.deepEqual(stored.target, { route: "/about/", title: "About me" });
  assert.deepEqual(stored.draftTree, tree);
  assert.equal(stored.draftUpdatedAt, NOW);
  assert.equal("tree" in stored, false); // nothing published until publishDraft
});

test("createPage NEVER overwrites an existing page (atomic, returns exists)", async () => {
  // Seed an existing page with its OWN draft. createPage MUST refuse and leave
  // the existing draft byte-unchanged (the upsert-silent-overwrite trap).
  const existingDraft = validTree({ maxItems: 9 });
  const db = makeDb([
    makeDoc({
      _id: "page:about", kind: "page", status: "published",
      target: { route: "/about/", title: "Original" },
      tree: validTree({ maxItems: 1 }),
      draftTree: existingDraft, draftUpdatedAt: "2026-01-01T00:00:00.000Z",
    }),
  ]);
  const result = await createPage(db, "about", pageTarget("about"), validTree({ maxItems: 4 }), { now });
  assert.deepEqual(result, { ok: false, error: "exists" });
  const stored = db.store.get("page:about");
  // The existing draft and target are untouched — NO overwrite.
  assert.deepEqual(stored.draftTree, existingDraft);
  assert.equal(stored.draftUpdatedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(stored.target, { route: "/about/", title: "Original" });
  assert.deepEqual(stored.tree, validTree({ maxItems: 1 }));
});

test("createPage → getEditorState round-trips the new page draft", async () => {
  const db = makeDb();
  const tree = validTree({ maxItems: 4 });
  await createPage(db, "now", pageTarget("now"), tree, { now });
  const state = await getEditorState(db, "page:now");
  assert.equal(state.isDraft, true);
  assert.deepEqual(state.tree, tree);
});

// ---- listPages (hub list helper, T5 consumer) ----

test("listPages returns published + draft page docs with summary shape", async () => {
  const db = makeDb([
    makeDoc(), // homepage — excluded (kind !== page)
    makeDoc({
      _id: "page:about", kind: "page", status: "published",
      target: { route: "/about/", title: "About" },
      tree: validTree(), updatedAt: "2026-06-02T00:00:00.000Z",
    }),
    makeDoc({
      _id: "page:now", kind: "page", status: "draft",
      target: { route: "/now/", title: "Now" },
      draftTree: validTree(), draftUpdatedAt: "2026-06-03T00:00:00.000Z",
    }),
  ]);
  const pages = await listPages(db);
  assert.equal(pages.length, 2);
  const about = pages.find((p) => p.slug === "about");
  const nowPage = pages.find((p) => p.slug === "now");
  assert.deepEqual(about, {
    slug: "about", route: "/about/", title: "About",
    hasDraft: false, status: "published", updatedAt: "2026-06-02T00:00:00.000Z",
  });
  assert.equal(nowPage.slug, "now");
  assert.equal(nowPage.route, "/now/");
  assert.equal(nowPage.hasDraft, true);
});

test("listPages returns [] when there are no page docs", async () => {
  const db = makeDb([makeDoc()]);
  assert.deepEqual(await listPages(db), []);
});

// ---- deleteComposition (delete/unpublish, D2) ----

test("deleteComposition removes the page doc (leaves the published set)", async () => {
  const db = makeDb([
    makeDoc({ _id: "page:about", kind: "page", target: { route: "/about/", title: "About" } }),
  ]);
  const result = await deleteComposition(db, "page:about");
  assert.deepEqual(result, { ok: true, deleted: true });
  assert.equal(db.store.has("page:about"), false);
});

test("deleteComposition on a non-existent doc is a graceful no-op", async () => {
  const db = makeDb();
  const result = await deleteComposition(db, "page:ghost");
  assert.deepEqual(result, { ok: true, deleted: false });
});
