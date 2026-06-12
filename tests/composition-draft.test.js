import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getEditorState,
  saveDraft,
  publishDraft,
  discardDraft,
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
        async updateOne({ _id }, update) {
          calls.push(["updateOne", name, _id, structuredClone(update)]);
          const doc = store.get(_id);
          if (!doc) return { matchedCount: 0, modifiedCount: 0 };
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
