import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_LIMIT,
  historyLabel,
} from "../lib/storage/composition-history.js";
import {
  publishDraft,
  createDraftFromTree,
} from "../lib/storage/composition-draft.js";
import { designRouter } from "../lib/controllers/design.js";
import { BUILTIN_BLOCKS } from "../lib/presets/builtin-blocks.js";

// In-memory db stub following the composition-draft tests' makeDb conventions
// (filter-aware updateOne mirroring $set/$unset + the {$exists} publish guard;
// replaceOne forbidden — drafts must stay atomic field updates).
function makeDb(docs = []) {
  const store = new Map(docs.map((doc) => [doc._id, structuredClone(doc)]));
  return {
    store,
    collection() {
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

const section = (id, type, config = {}) => ({ block: "section", id, type, v: 0, config });

const container = (id, role, children, extra = {}) => ({
  block: "container", id, as: "stack", role, children, ...extra,
});

/** A valid (strict-gate-passing) tree with the given main-stack sections. */
const treeWith = (sections) =>
  container("c_root", "root", [container("c_main", "main", sections)]);

const validTree = (sectionConfig = { maxItems: 10 }) =>
  treeWith([section("b_1", "recent-posts", sectionConfig)]);

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
const JULY = "2026-07-24T12:00:00.000Z";

// ---- historyLabel (pure classifier) ----

test("historyLabel: block added → addition, month from the ISO date", () => {
  const prev = treeWith([section("b_1", "recent-posts", { maxItems: 10 })]);
  const next = treeWith([
    section("b_1", "recent-posts", { maxItems: 10 }),
    section("b_2", "recent-posts", { maxItems: 5 }),
  ]);
  assert.deepEqual(historyLabel(prev, next, JULY), { month: 7, noun: "addition" });
});

test("historyLabel: block removed → trim", () => {
  const prev = treeWith([
    section("b_1", "recent-posts", { maxItems: 10 }),
    section("b_2", "recent-posts", { maxItems: 5 }),
  ]);
  const next = treeWith([section("b_1", "recent-posts", { maxItems: 10 })]);
  assert.deepEqual(historyLabel(prev, next, NOW), { month: 6, noun: "trim" });
});

test("historyLabel: same blocks reordered → rearrangement", () => {
  const a = section("b_1", "recent-posts", { maxItems: 10 });
  const b = section("b_2", "recent-posts", { maxItems: 5 });
  assert.deepEqual(historyLabel(treeWith([a, b]), treeWith([b, a]), NOW), {
    month: 6,
    noun: "rearrangement",
  });
});

test("historyLabel: same blocks moved to another zone → rearrangement", () => {
  const a = section("b_1", "recent-posts", { maxItems: 10 });
  const prev = container("c_root", "root", [container("c_main", "main", [a])]);
  const next = container("c_root", "root", [
    container("c_main", "main", []),
    container("c_side", "complementary", [a]),
  ]);
  assert.deepEqual(historyLabel(prev, next, NOW), { month: 6, noun: "rearrangement" });
});

test("historyLabel: same structure, config changed → tune-up", () => {
  const prev = validTree({ maxItems: 10 });
  const next = validTree({ maxItems: 5 });
  assert.deepEqual(historyLabel(prev, next, NOW), { month: 6, noun: "tune-up" });
});

test("historyLabel: container-only change (same sections, same configs) → tune-up", () => {
  const a = section("b_1", "recent-posts", { maxItems: 10 });
  const prev = container("c_root", "root", [container("c_main", "main", [a])]);
  const next = container("c_root", "root", [
    container("c_main", "main", [a], { variant: { gap: "loose" } }),
  ]);
  assert.deepEqual(historyLabel(prev, next, NOW), { month: 6, noun: "tune-up" });
});

test("historyLabel: add + remove together → remodel", () => {
  const prev = treeWith([
    section("b_1", "recent-posts", { maxItems: 10 }),
    section("b_2", "recent-posts", { maxItems: 5 }),
  ]);
  const next = treeWith([
    section("b_1", "recent-posts", { maxItems: 10 }),
    section("b_3", "custom-html", { content: "<p>hi</p>" }),
  ]);
  assert.deepEqual(historyLabel(prev, next, NOW), { month: 6, noun: "remodel" });
});

test("historyLabel: structural + config changes combined → remodel", () => {
  const prev = treeWith([section("b_1", "recent-posts", { maxItems: 10 })]);
  const next = treeWith([
    section("b_1", "recent-posts", { maxItems: 3 }), // config changed…
    section("b_2", "recent-posts", { maxItems: 5 }), // …and a block added
  ]);
  assert.deepEqual(historyLabel(prev, next, NOW), { month: 6, noun: "remodel" });
});

test("historyLabel: identical trees → null (no history entry)", () => {
  assert.equal(historyLabel(validTree(), validTree(), NOW), null);
});

// ---- publishDraft history snapshot ----

test("publishDraft archives the OUTGOING tree at history[0] when the promote changes it", async () => {
  const draft = validTree({ maxItems: 5 });
  const db = makeDb([makeDoc({ draftTree: draft, draftUpdatedAt: "2026-06-11T00:00:00.000Z" })]);
  const result = await publishDraft(db, "homepage", BUILTIN_BLOCKS, {
    writeArtifact: async () => {},
    now,
  });
  assert.deepEqual(result, { ok: true });
  const stored = db.store.get("homepage");
  assert.deepEqual(stored.tree, draft);
  assert.equal(stored.history.length, 1);
  assert.deepEqual(stored.history[0], {
    tree: validTree(), // the outgoing published tree, not the candidate
    label: { month: 6, noun: "tune-up" },
    archivedAt: NOW,
  });
});

test("publishDraft prepends to existing history and caps the ring at 10", async () => {
  const older = Array.from({ length: 10 }, (_, i) => ({
    tree: validTree({ maxItems: i + 1 }),
    label: { month: 1, noun: "tune-up" },
    archivedAt: `2026-01-0${(i % 9) + 1}T00:00:00.000Z`,
  }));
  const db = makeDb([
    makeDoc({ history: older, draftTree: validTree({ maxItems: 42 }), draftUpdatedAt: NOW }),
  ]);
  await publishDraft(db, "homepage", BUILTIN_BLOCKS, { writeArtifact: async () => {}, now });
  const stored = db.store.get("homepage");
  assert.equal(stored.history.length, HISTORY_LIMIT);
  assert.deepEqual(stored.history[0].tree, validTree()); // newest first
  assert.deepEqual(stored.history[1], older[0]); // prior ring shifted down
  assert.deepEqual(stored.history.at(-1), older[8]); // oldest entry dropped
});

test("publishDraft: republish with no change records NO history entry", async () => {
  const db = makeDb([makeDoc()]); // no draft — republish of the stored tree
  const result = await publishDraft(db, "homepage", BUILTIN_BLOCKS, {
    writeArtifact: async () => {},
    now,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal("history" in db.store.get("homepage"), false);
});

test("publishDraft: a draft identical to the published tree records NO history entry", async () => {
  const db = makeDb([makeDoc({ draftTree: validTree(), draftUpdatedAt: NOW })]);
  await publishDraft(db, "homepage", BUILTIN_BLOCKS, { writeArtifact: async () => {}, now });
  assert.equal("history" in db.store.get("homepage"), false);
});

test("publishDraft: first-ever publish (no prior tree) records NO history entry", async () => {
  const db = makeDb();
  await createDraftFromTree(db, "homepage", "homepage", validTree(), { now });
  const result = await publishDraft(db, "homepage", BUILTIN_BLOCKS, {
    writeArtifact: async () => {},
    now,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal("history" in db.store.get("homepage"), false);
});

test("publishDraft: the public artifact carries NO history field", async () => {
  const db = makeDb([makeDoc({ draftTree: validTree({ maxItems: 5 }), draftUpdatedAt: NOW })]);
  const artifacts = [];
  await publishDraft(db, "homepage", BUILTIN_BLOCKS, {
    writeArtifact: async (doc) => artifacts.push(doc),
    now,
  });
  assert.equal("history" in artifacts[0], false);
});

// ---- POST …/history/<index>/restore (restore-as-draft route) ----

const makeIds = () => { let n = 0; return (prefix) => `${prefix}_${String(++n).padStart(6, "0")}`; };

function makeIndiekit(compositions) {
  const db = makeDb(compositions);
  return {
    database: db,
    _db: db,
    endpoints: [],
    config: {
      application: { blockCatalog: BUILTIN_BLOCKS },
      publication: { me: "https://example.test" },
    },
  };
}

function makeRouter(ik) {
  return designRouter(ik, {
    idFactory: makeIds(),
    writePreviewArtifact: async () => {},
  });
}

// Minimal router harness following the design-controller tests' callRoute.
function callRoute(router, method, url, body = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url, "http://localhost");
    const req = {
      method: method.toUpperCase(),
      url,
      body,
      headers: {},
      query: Object.fromEntries(parsed.searchParams),
    };
    const res = {
      statusCode: 200,
      redirected: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      send(payload) { this.body = payload; resolve(this); },
      redirect(status, target) {
        this.redirected = { status, url: target };
        resolve(this);
      },
      render() { resolve(this); },
    };
    router.handle(req, res, (error) =>
      reject(error ?? new Error(`unhandled ${method} ${url}`)),
    );
  });
}

const flag = (res, name) => new URL(res.redirected.url, "http://x").searchParams.get(name);

const archivedEntry = (config = { maxItems: 3 }) => ({
  tree: validTree(config),
  label: { month: 7, noun: "rearrangement" },
  archivedAt: "2026-07-01T00:00:00.000Z",
});

test("restore writes the archived tree as the DRAFT; published tree untouched; flash carries the label", async () => {
  const ik = makeIndiekit([makeDoc({ history: [archivedEntry()] })]);
  const res = await callRoute(makeRouter(ik), "post", "/homepage/history/0/restore");
  assert.equal(res.redirected.status, 303);
  assert.equal(flag(res, "restoredHistory"), "1");
  assert.equal(flag(res, "hm"), "7");
  assert.equal(flag(res, "hn"), "rearrangement");
  assert.ok(res.redirected.url.startsWith("/site-config/design/homepage?"));
  const stored = ik._db.store.get("homepage");
  assert.deepEqual(stored.draftTree, validTree({ maxItems: 3 })); // archived tree is now the draft
  assert.deepEqual(stored.tree, validTree()); // published tree untouched
  assert.deepEqual(stored.history, [archivedEntry()]); // ring untouched by restore
});

test("restore rejects out-of-shape indexes (negative, >9, non-integer) with a flash", async () => {
  for (const bad of ["-1", "10", "1.5", "abc"]) {
    const ik = makeIndiekit([makeDoc({ history: [archivedEntry()] })]);
    const res = await callRoute(makeRouter(ik), "post", `/homepage/history/${bad}/restore`);
    assert.equal(flag(res, "error"), "history-invalid", `index ${bad} must flash`);
    assert.equal("draftTree" in ik._db.store.get("homepage"), false, `index ${bad} must not write`);
  }
});

test("restore rejects an in-shape index with no entry behind it", async () => {
  const ik = makeIndiekit([makeDoc({ history: [archivedEntry()] })]);
  const res = await callRoute(makeRouter(ik), "post", "/homepage/history/5/restore");
  assert.equal(flag(res, "error"), "history-invalid");
  assert.equal("draftTree" in ik._db.store.get("homepage"), false);
});

test("restore on a surface with no composition doc → no-composition flash", async () => {
  const ik = makeIndiekit([]);
  const res = await callRoute(makeRouter(ik), "post", "/homepage/history/0/restore");
  assert.equal(flag(res, "error"), "no-composition");
});

test("restore works on the slug-scoped pages surface (per-page history)", async () => {
  const ik = makeIndiekit([
    makeDoc({ _id: "page:about", kind: "page", history: [archivedEntry({ maxItems: 8 })] }),
  ]);
  const res = await callRoute(makeRouter(ik), "post", "/pages/about/history/0/restore");
  assert.equal(flag(res, "restoredHistory"), "1");
  assert.ok(res.redirected.url.startsWith("/site-config/design/pages/about?"));
  assert.deepEqual(ik._db.store.get("page:about").draftTree, validTree({ maxItems: 8 }));
});
