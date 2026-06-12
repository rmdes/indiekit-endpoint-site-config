import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getPreviewState,
  ensureToken,
  bumpRevision,
  rotateToken,
} from "../lib/storage/preview-state.js";

/**
 * makeDb following the storage-test conventions (filter-aware updateOne, no
 * whole-doc replaces) extended with what preview-state needs: $setOnInsert
 * semantics ($setOnInsert is INERT on a matched doc — real Mongo behavior),
 * $inc, and findOneAndUpdate (returnDocument: "after").
 */
function makeDb(seed = [], { findOneAndUpdateShape = "doc" } = {}) {
  const store = new Map(seed.map((doc) => [doc._id, structuredClone(doc)]));

  const matches = (doc, filter) =>
    doc &&
    Object.entries(filter).every(([key, cond]) => {
      if (key === "_id") return true;
      if (cond && typeof cond === "object" && "$exists" in cond) {
        return (key in doc) === cond.$exists;
      }
      return doc[key] === cond;
    });

  const apply = (doc, update) => {
    for (const [k, v] of Object.entries(update.$set ?? {})) doc[k] = v;
    for (const [k, v] of Object.entries(update.$inc ?? {})) doc[k] = (doc[k] ?? 0) + v;
    for (const k of Object.keys(update.$unset ?? {})) delete doc[k];
  };

  const insertFromUpsert = (filter, update) => {
    const inserted = { _id: filter._id };
    for (const [k, v] of Object.entries(update.$setOnInsert ?? {})) inserted[k] = v;
    apply(inserted, update);
    store.set(filter._id, inserted);
    return inserted;
  };

  return {
    store,
    collection(name) {
      assert.equal(name, "siteConfig"); // preview state lives on the siteConfig doc
      return {
        async findOne({ _id }) {
          return store.get(_id) ?? null;
        },
        async updateOne(filter, update, options = {}) {
          const doc = store.get(filter._id);
          if (!matches(doc, filter)) {
            if (options.upsert && !store.has(filter._id)) {
              insertFromUpsert(filter, update);
              return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
            }
            return { matchedCount: 0, modifiedCount: 0 };
          }
          apply(doc, update); // $setOnInsert inert on a match
          return { matchedCount: 1, modifiedCount: 1 };
        },
        async findOneAndUpdate(filter, update, options = {}) {
          let doc = store.get(filter._id);
          if (!matches(doc, filter)) {
            if (!options.upsert) return findOneAndUpdateShape === "doc" ? null : { value: null };
            doc = insertFromUpsert(filter, update);
          } else {
            apply(doc, update);
          }
          const after = structuredClone(doc);
          // Driver v6 returns the doc; v4/v5 wrap it in { value }.
          return findOneAndUpdateShape === "doc" ? after : { value: after };
        },
      };
    },
  };
}

// ---- getPreviewState ----

test("getPreviewState defaults to {token: null, revision: 0} when no doc or fields", async () => {
  assert.deepEqual(await getPreviewState(makeDb()), { token: null, revision: 0 });
  assert.deepEqual(
    await getPreviewState(makeDb([{ _id: "primary", identity: { name: "x" } }])),
    { token: null, revision: 0 },
  );
});

test("getPreviewState reads previewToken/previewRevision off the siteConfig doc", async () => {
  const db = makeDb([{ _id: "primary", previewToken: "tok", previewRevision: 7 }]);
  assert.deepEqual(await getPreviewState(db), { token: "tok", revision: 7 });
});

// ---- ensureToken ----

test("ensureToken generates a 16-byte base64url token when absent (no doc)", async () => {
  const db = makeDb();
  const token = await ensureToken(db);
  assert.equal(typeof token, "string");
  assert.equal(token.length, 22); // 16 bytes → 22 base64url chars
  assert.match(token, /^[\w-]+$/); // base64url alphabet only
  assert.equal(db.store.get("primary").previewToken, token);
});

test("ensureToken adds the field to an EXISTING doc without touching siblings", async () => {
  const db = makeDb([{ _id: "primary", identity: { name: "x" }, previewRevision: 2 }]);
  const token = await ensureToken(db, { random: () => "fixed-token" });
  assert.equal(token, "fixed-token");
  const doc = db.store.get("primary");
  assert.equal(doc.previewToken, "fixed-token");
  assert.deepEqual(doc.identity, { name: "x" });
  assert.equal(doc.previewRevision, 2);
});

test("ensureToken returns the EXISTING token unchanged (idempotent — never double-generates)", async () => {
  const db = makeDb([{ _id: "primary", previewToken: "existing" }]);
  const token = await ensureToken(db, { random: () => "should-not-be-used" });
  assert.equal(token, "existing");
  assert.equal(db.store.get("primary").previewToken, "existing");
});

test("ensureToken called twice converges on one token", async () => {
  const db = makeDb();
  const first = await ensureToken(db);
  const second = await ensureToken(db);
  assert.equal(first, second);
});

test("ensureToken survives a concurrent-upsert duplicate-key race (E11000)", async () => {
  // Simulate: our upsert loses the insert race — Mongo throws code 11000 and
  // the winner's doc (with ITS token) is now in place.
  const db = makeDb();
  const realCollection = db.collection.bind(db);
  let raced = false;
  db.collection = (name) => {
    const col = realCollection(name);
    return {
      ...col,
      async updateOne(filter, update, options = {}) {
        if (options.upsert && !raced) {
          raced = true;
          db.store.set("primary", { _id: "primary", previewToken: "winner" });
          const error = new Error("E11000 duplicate key");
          error.code = 11_000;
          throw error;
        }
        return col.updateOne(filter, update, options);
      },
    };
  };
  const token = await ensureToken(db, { random: () => "loser" });
  assert.equal(token, "winner"); // read-back is authoritative
  assert.equal(db.store.get("primary").previewToken, "winner");
});

test("ensureToken rethrows non-duplicate-key errors", async () => {
  const db = {
    collection: () => ({
      async updateOne() {
        throw new Error("network down");
      },
      async findOne() {
        return null;
      },
    }),
  };
  await assert.rejects(() => ensureToken(db), /network down/);
});

// ---- bumpRevision ----

test("bumpRevision $incs atomically and returns the NEW value (monotonic)", async () => {
  const db = makeDb([{ _id: "primary", previewRevision: 4 }]);
  assert.equal(await bumpRevision(db), 5);
  assert.equal(await bumpRevision(db), 6);
  assert.equal(db.store.get("primary").previewRevision, 6);
});

test("bumpRevision upserts: no doc → revision 1; absent field → 1", async () => {
  const empty = makeDb();
  assert.equal(await bumpRevision(empty), 1);
  const noField = makeDb([{ _id: "primary", previewToken: "tok" }]);
  assert.equal(await bumpRevision(noField), 1);
  assert.equal(noField.store.get("primary").previewToken, "tok"); // siblings untouched
});

test("bumpRevision tolerates both driver result shapes (v6 doc / v4-v5 {value})", async () => {
  const wrapped = makeDb([{ _id: "primary", previewRevision: 9 }], {
    findOneAndUpdateShape: "value",
  });
  assert.equal(await bumpRevision(wrapped), 10);
});

// ---- rotateToken ----

test("rotateToken unconditionally replaces the token and returns the new one", async () => {
  const db = makeDb([{ _id: "primary", previewToken: "old", previewRevision: 3 }]);
  const token = await rotateToken(db);
  assert.notEqual(token, "old");
  assert.equal(token.length, 22);
  const doc = db.store.get("primary");
  assert.equal(doc.previewToken, token);
  assert.equal(doc.previewRevision, 3); // revision untouched — bump is separate
});

test("rotateToken upserts when no doc exists and accepts an injected random", async () => {
  const db = makeDb();
  const token = await rotateToken(db, { random: () => "rotated" });
  assert.equal(token, "rotated");
  assert.equal(db.store.get("primary").previewToken, "rotated");
});
