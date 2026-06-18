import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getPreviewState,
  ensureToken,
  bumpRevision,
  rotateToken,
} from "../lib/storage/preview-state.js";

/**
 * Per-surface preview state (#32-T1). State is a map keyed by routeKey
 * (`"homepage"`, `"listing"`, `"posttype"` — no colons, safe Mongo field
 * names) at `previews.<routeKey>.{token,revision}` on siteConfig _id:"primary".
 *
 * This mock-db mirrors preview-state.test.js but supports DOTTED-PATH
 * $set/$setOnInsert/$inc and $exists filters on dotted paths (real Mongo
 * semantics), since the per-surface module operates on `previews.<key>.field`.
 */
function makeDb(seed = [], { findOneAndUpdateShape = "doc" } = {}) {
  const store = new Map(seed.map((doc) => [doc._id, structuredClone(doc)]));

  const getPath = (doc, path) => {
    let cur = doc;
    for (const part of path.split(".")) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[part];
    }
    return cur;
  };

  const hasPath = (doc, path) => {
    let cur = doc;
    const parts = path.split(".");
    for (let i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== "object" || !(parts[i] in cur)) {
        return false;
      }
      cur = cur[parts[i]];
    }
    return true;
  };

  const setPath = (doc, path, value) => {
    const parts = path.split(".");
    let cur = doc;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") {
        cur[parts[i]] = {};
      }
      cur = cur[parts[i]];
    }
    cur[parts.at(-1)] = value;
  };

  const matches = (doc, filter) =>
    doc &&
    Object.entries(filter).every(([key, cond]) => {
      if (key === "_id") return true;
      if (cond && typeof cond === "object" && "$exists" in cond) {
        return hasPath(doc, key) === cond.$exists;
      }
      return getPath(doc, key) === cond;
    });

  const apply = (doc, update) => {
    for (const [k, v] of Object.entries(update.$set ?? {})) setPath(doc, k, v);
    for (const [k, v] of Object.entries(update.$inc ?? {})) {
      setPath(doc, k, (getPath(doc, k) ?? 0) + v);
    }
    for (const [k] of Object.entries(update.$unset ?? {})) {
      const parts = k.split(".");
      let cur = doc;
      for (let i = 0; i < parts.length - 1; i++) cur = cur?.[parts[i]];
      if (cur) delete cur[parts.at(-1)];
    }
  };

  const insertFromUpsert = (filter, update) => {
    const inserted = { _id: filter._id };
    for (const [k, v] of Object.entries(update.$setOnInsert ?? {})) {
      setPath(inserted, k, v);
    }
    apply(inserted, update);
    store.set(filter._id, inserted);
    return inserted;
  };

  return {
    store,
    collection(name) {
      assert.equal(name, "siteConfig");
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
          apply(doc, update);
          return { matchedCount: 1, modifiedCount: 1 };
        },
        async findOneAndUpdate(filter, update, options = {}) {
          let doc = store.get(filter._id);
          if (!matches(doc, filter)) {
            if (!options.upsert)
              return findOneAndUpdateShape === "doc" ? null : { value: null };
            doc = insertFromUpsert(filter, update);
          } else {
            apply(doc, update);
          }
          const after = structuredClone(doc);
          return findOneAndUpdateShape === "doc" ? after : { value: after };
        },
      };
    },
  };
}

const slot = (db, routeKey) => db.store.get("primary")?.previews?.[routeKey];

// ---- getPreviewState (per-surface) ----

test("getPreviewState(db, routeKey) defaults to {token:null, revision:0} when absent", async () => {
  assert.deepEqual(await getPreviewState(makeDb(), "listing"), {
    token: null,
    revision: 0,
  });
  assert.deepEqual(
    await getPreviewState(
      makeDb([{ _id: "primary", identity: { name: "x" } }]),
      "posttype",
    ),
    { token: null, revision: 0 },
  );
});

test("getPreviewState reads previews.<routeKey>.{token,revision}", async () => {
  const db = makeDb([
    {
      _id: "primary",
      previews: {
        homepage: { token: "h", revision: 7 },
        listing: { token: "l", revision: 2 },
      },
    },
  ]);
  assert.deepEqual(await getPreviewState(db, "homepage"), {
    token: "h",
    revision: 7,
  });
  assert.deepEqual(await getPreviewState(db, "listing"), {
    token: "l",
    revision: 2,
  });
  assert.deepEqual(await getPreviewState(db, "posttype"), {
    token: null,
    revision: 0,
  });
});

// ---- ensureToken (per-surface) ----

test("ensureToken(db, routeKey) generates a token at previews.<routeKey>.token when absent", async () => {
  const db = makeDb();
  const token = await ensureToken(db, "listing");
  assert.equal(typeof token, "string");
  assert.equal(token.length, 22);
  assert.match(token, /^[\w-]+$/);
  assert.equal(slot(db, "listing").token, token);
});

test("ensureToken adds the slot to an EXISTING doc without touching siblings", async () => {
  const db = makeDb([
    {
      _id: "primary",
      identity: { name: "x" },
      previews: { homepage: { token: "h", revision: 3 } },
    },
  ]);
  const token = await ensureToken(db, "listing", { random: () => "fixed" });
  assert.equal(token, "fixed");
  assert.equal(slot(db, "listing").token, "fixed");
  // homepage slot untouched
  assert.deepEqual(slot(db, "homepage"), { token: "h", revision: 3 });
  assert.deepEqual(db.store.get("primary").identity, { name: "x" });
});

test("ensureToken returns the EXISTING per-surface token unchanged (idempotent)", async () => {
  const db = makeDb([
    { _id: "primary", previews: { listing: { token: "existing" } } },
  ]);
  const token = await ensureToken(db, "listing", { random: () => "nope" });
  assert.equal(token, "existing");
  assert.equal(slot(db, "listing").token, "existing");
});

test("ensureToken called twice for the same surface converges on one token", async () => {
  const db = makeDb();
  const first = await ensureToken(db, "posttype");
  const second = await ensureToken(db, "posttype");
  assert.equal(first, second);
});

test("ensureToken survives a concurrent-upsert E11000 (read-back authoritative)", async () => {
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
          db.store.set("primary", {
            _id: "primary",
            previews: { listing: { token: "winner" } },
          });
          const error = new Error("E11000 duplicate key");
          error.code = 11_000;
          throw error;
        }
        return col.updateOne(filter, update, options);
      },
    };
  };
  const token = await ensureToken(db, "listing", { random: () => "loser" });
  assert.equal(token, "winner");
  assert.equal(slot(db, "listing").token, "winner");
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
  await assert.rejects(() => ensureToken(db, "listing"), /network down/);
});

// ---- bumpRevision (per-surface) ----

test("bumpRevision(db, routeKey) $incs previews.<routeKey>.revision and returns NEW value", async () => {
  const db = makeDb([
    { _id: "primary", previews: { listing: { revision: 4 } } },
  ]);
  assert.equal(await bumpRevision(db, "listing"), 5);
  assert.equal(await bumpRevision(db, "listing"), 6);
  assert.equal(slot(db, "listing").revision, 6);
});

test("bumpRevision upserts: no doc → 1; absent slot → 1", async () => {
  const empty = makeDb();
  assert.equal(await bumpRevision(empty, "posttype"), 1);
  assert.equal(slot(empty, "posttype").revision, 1);

  const noSlot = makeDb([
    { _id: "primary", previews: { homepage: { token: "h", revision: 9 } } },
  ]);
  assert.equal(await bumpRevision(noSlot, "listing"), 1);
  // homepage slot untouched
  assert.deepEqual(slot(noSlot, "homepage"), { token: "h", revision: 9 });
});

test("bumpRevision tolerates both driver result shapes (v6 doc / v4-v5 {value})", async () => {
  const wrapped = makeDb([{ _id: "primary", previews: { listing: { revision: 9 } } }], {
    findOneAndUpdateShape: "value",
  });
  assert.equal(await bumpRevision(wrapped, "listing"), 10);
});

// ---- rotateToken (per-surface) ----

test("rotateToken(db, routeKey) unconditionally replaces previews.<routeKey>.token", async () => {
  const db = makeDb([
    {
      _id: "primary",
      previews: { listing: { token: "old", revision: 3 } },
    },
  ]);
  const token = await rotateToken(db, "listing");
  assert.notEqual(token, "old");
  assert.equal(token.length, 22);
  assert.equal(slot(db, "listing").token, token);
  assert.equal(slot(db, "listing").revision, 3); // revision untouched
});

test("rotateToken upserts when no doc exists and accepts an injected random", async () => {
  const db = makeDb();
  const token = await rotateToken(db, "posttype", { random: () => "rotated" });
  assert.equal(token, "rotated");
  assert.equal(slot(db, "posttype").token, "rotated");
});

// ---- INDEPENDENCE (critical): one surface's ops never touch another's ----

test("INDEPENDENCE: bumping/ensuring/rotating listing never touches homepage", async () => {
  const db = makeDb([
    {
      _id: "primary",
      previews: { homepage: { token: "home-tok", revision: 5 } },
    },
  ]);
  await ensureToken(db, "listing", { random: () => "list-tok" });
  await bumpRevision(db, "listing");
  await rotateToken(db, "listing", { random: () => "list-tok-2" });

  // homepage slot is byte-identical to its seeded state
  assert.deepEqual(slot(db, "homepage"), { token: "home-tok", revision: 5 });
  assert.equal(slot(db, "listing").token, "list-tok-2");
  assert.equal(slot(db, "listing").revision, 1);
});

test("INDEPENDENCE: per-surface revisions are independent counters", async () => {
  const db = makeDb();
  assert.equal(await bumpRevision(db, "homepage"), 1);
  assert.equal(await bumpRevision(db, "homepage"), 2);
  assert.equal(await bumpRevision(db, "listing"), 1); // own counter, not 3
  assert.equal(await bumpRevision(db, "posttype"), 1);
  assert.equal(await bumpRevision(db, "homepage"), 3);
  assert.equal(slot(db, "homepage").revision, 3);
  assert.equal(slot(db, "listing").revision, 1);
  assert.equal(slot(db, "posttype").revision, 1);
});

// ---- MIGRATION: legacy flat fields → previews.homepage (non-destructive) ----

test("MIGRATION: legacy flat previewToken/previewRevision read under homepage", async () => {
  const db = makeDb([
    { _id: "primary", previewToken: "abc", previewRevision: 7 },
  ]);
  assert.deepEqual(await getPreviewState(db, "homepage"), {
    token: "abc",
    revision: 7,
  });
});

test("MIGRATION: legacy values do NOT bleed into non-homepage surfaces", async () => {
  const db = makeDb([
    { _id: "primary", previewToken: "abc", previewRevision: 7 },
  ]);
  assert.deepEqual(await getPreviewState(db, "listing"), {
    token: null,
    revision: 0,
  });
  assert.deepEqual(await getPreviewState(db, "posttype"), {
    token: null,
    revision: 0,
  });
});

test("MIGRATION: a subsequent homepage bump lands at previews.homepage.revision (8), preserving the live token", async () => {
  const db = makeDb([
    { _id: "primary", previewToken: "abc", previewRevision: 7 },
  ]);
  // legacy revision 7 → migrated → bump → 8
  assert.equal(await bumpRevision(db, "homepage"), 8);
  assert.equal(slot(db, "homepage").revision, 8);
  // the live token survived
  assert.equal(slot(db, "homepage").token, "abc");
  // a subsequent ensure returns the migrated token, never regenerates
  const token = await ensureToken(db, "homepage", { random: () => "nope" });
  assert.equal(token, "abc");
});

test("MIGRATION: ensureToken on legacy doc returns the live token (no regenerate)", async () => {
  const db = makeDb([
    { _id: "primary", previewToken: "abc", previewRevision: 7 },
  ]);
  const token = await ensureToken(db, "homepage", { random: () => "regenerated" });
  assert.equal(token, "abc");
  assert.equal(slot(db, "homepage").token, "abc");
});

test("MIGRATION: does NOT clobber an already-migrated previews.homepage", async () => {
  // Both legacy flat fields AND a real previews.homepage exist (e.g. a second
  // boot after migration already ran). The migration must NOT overwrite the
  // already-migrated slot with the stale legacy values.
  const db = makeDb([
    {
      _id: "primary",
      previewToken: "stale-legacy",
      previewRevision: 1,
      previews: { homepage: { token: "migrated", revision: 9 } },
    },
  ]);
  assert.deepEqual(await getPreviewState(db, "homepage"), {
    token: "migrated",
    revision: 9,
  });
  const token = await ensureToken(db, "homepage", { random: () => "nope" });
  assert.equal(token, "migrated");
  assert.equal(await bumpRevision(db, "homepage"), 10);
});
