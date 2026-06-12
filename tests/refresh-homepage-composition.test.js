import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshHomepageComposition } from "../lib/storage/refresh-homepage-composition.js";
import { BUILTIN_BLOCKS } from "../lib/presets/builtin-blocks.js";

// Deterministic id factory for assertions (same convention as the migrator tests).
const makeIds = () => { let n = 0; return (prefix) => `${prefix}_${String(++n).padStart(6, "0")}`; };

const V3 = {
  layout: "two-column",
  hero: { enabled: true, showSocial: true, ctaText: "Read more", ctaUrl: "/about/" },
  sections: [
    { type: "recent-posts", config: { maxItems: 10 } },
    { type: "posting-activity", config: {} },
  ],
  sidebar: [{ type: "author-card", config: {} }, { type: "categories", config: {} }],
  footer: [{ type: "custom-html", config: { content: "<p>bye</p>" } }],
};

// Same stub shape as tests/migrate-v3-to-v4.test.js makeDb.
function makeDb(homepageDoc) {
  const stores = { homepageConfig: new Map(), compositions: new Map() };
  if (homepageDoc) stores.homepageConfig.set("homepage", { _id: "homepage", ...homepageDoc });
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
      };
    },
  };
}

test("valid v3 doc → upserts the homepage composition AND writes the artifact, ok report", async () => {
  const db = makeDb(V3);
  const written = [];
  const report = await refreshHomepageComposition(db, BUILTIN_BLOCKS, {
    writeArtifact: async (doc) => { written.push(doc); return "/tmp/homepage.json"; },
  });
  assert.equal(report.ok, true);
  assert.equal(report.skipped, false);
  assert.deepEqual(report.errors, []);
  assert.ok(Array.isArray(report.warnings));

  const stored = db.stores.compositions.get("homepage");
  assert.ok(stored, "composition doc upserted");
  assert.equal(stored.schemaVersion, 4);
  assert.equal(stored.kind, "homepage");
  assert.equal(stored.status, "published");
  assert.equal(stored.tree.role, "root");
  assert.match(stored.updatedAt, /^\d{4}-\d{2}-\d{2}T/); // ISO string (workspace convention)
  assert.equal(stored.updatedBy, "refresh-homepage-composition");

  // The artifact writer received the SAME fresh doc that was persisted.
  assert.equal(written.length, 1);
  assert.deepEqual(written[0], stored);
});

test("OVERWRITES an existing composition (explicit refresh — distinct from the migrator's seed-if-absent)", async () => {
  const db = makeDb(V3);
  db.stores.compositions.set("homepage", { _id: "homepage", sentinel: true });
  const report = await refreshHomepageComposition(db, BUILTIN_BLOCKS, {
    writeArtifact: async () => {},
  });
  assert.equal(report.ok, true);
  const stored = db.stores.compositions.get("homepage");
  assert.equal("sentinel" in stored, false, "existing doc replaced, not preserved");
  assert.equal(stored.kind, "homepage");
});

test("invalid tree → NO db write, NO artifact write, ok:false with errors (never replace good with bad)", async () => {
  // Poison beyond schema bounds: recent-posts maxItems maximum is 50.
  const db = makeDb({ ...V3, sections: [{ type: "recent-posts", config: { maxItems: 999 } }] });
  db.stores.compositions.set("homepage", { _id: "homepage", sentinel: true });
  const written = [];
  const report = await refreshHomepageComposition(db, BUILTIN_BLOCKS, {
    writeArtifact: async (doc) => { written.push(doc); },
  });
  assert.equal(report.ok, false);
  assert.ok(report.errors.length > 0);
  assert.equal(written.length, 0, "artifact writer must not be called");
  // The pre-existing (good) composition survives untouched.
  assert.deepEqual(db.stores.compositions.get("homepage"), { _id: "homepage", sentinel: true });
});

test("no v3 doc → no-op with full uniform report shape (skipped: true)", async () => {
  const db = makeDb(null);
  const written = [];
  const report = await refreshHomepageComposition(db, BUILTIN_BLOCKS, {
    writeArtifact: async (doc) => { written.push(doc); },
  });
  assert.deepEqual(report, {
    ok: true,
    skipped: true,
    reason: "no v3 homepageConfig doc",
    errors: [],
    warnings: [],
  });
  assert.equal(db.stores.compositions.size, 0);
  assert.equal(written.length, 0);
});

test("uniform report shape: every non-skipped key also present on the skipped report", async () => {
  const normal = await refreshHomepageComposition(makeDb(V3), BUILTIN_BLOCKS, {
    writeArtifact: async () => {},
  });
  const skipped = await refreshHomepageComposition(makeDb(null), BUILTIN_BLOCKS, {
    writeArtifact: async () => {},
  });
  for (const key of Object.keys(normal)) {
    assert.equal(key in skipped, true, `skipped report missing "${key}"`);
  }
});

test("the doc is fully rebuilt with FRESH ids on each refresh (documented Phase 3 behavior)", async () => {
  const db = makeDb(V3);
  const options = { writeArtifact: async () => {} };
  await refreshHomepageComposition(db, BUILTIN_BLOCKS, options);
  const firstIds = collectIds(db.stores.compositions.get("homepage").tree);
  await refreshHomepageComposition(db, BUILTIN_BLOCKS, options);
  const secondIds = collectIds(db.stores.compositions.get("homepage").tree);
  // Random b_/c_ ids — a full rebuild produces a disjoint id set.
  assert.equal(firstIds.some((id) => secondIds.includes(id)), false);
});

test("injectable idFactory / now / updatedBy (deterministic output)", async () => {
  const db = makeDb(V3);
  await refreshHomepageComposition(db, BUILTIN_BLOCKS, {
    writeArtifact: async () => {},
    idFactory: makeIds(),
    now: () => "2026-06-12T10:00:00.000Z",
    updatedBy: "test-caller",
  });
  const stored = db.stores.compositions.get("homepage");
  assert.equal(stored.updatedAt, "2026-06-12T10:00:00.000Z");
  assert.equal(stored.updatedBy, "test-caller");
  assert.equal(stored.tree.children[0].id, "b_000001"); // hero is the first emitted node
});

test("db errors propagate to the caller (controller's try/catch owns them)", async () => {
  const db = {
    collection() {
      return { async findOne() { throw new Error("mongo down"); } };
    },
  };
  await assert.rejects(
    () => refreshHomepageComposition(db, BUILTIN_BLOCKS, { writeArtifact: async () => {} }),
    /mongo down/,
  );
});

test("artifact writer errors propagate too (caller catches — boot/save wiring warns)", async () => {
  const db = makeDb(V3);
  await assert.rejects(
    () => refreshHomepageComposition(db, BUILTIN_BLOCKS, {
      writeArtifact: async () => { throw new Error("disk full"); },
    }),
    /disk full/,
  );
});

function collectIds(node, out = []) {
  out.push(node.id);
  for (const child of node.children || []) collectIds(child, out);
  return out;
}
