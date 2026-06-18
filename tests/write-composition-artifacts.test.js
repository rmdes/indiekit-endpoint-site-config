import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCompositionArtifacts } from "../lib/render/write-composition-json.js";

/**
 * Boot artifact-write loop (6.3-T6). At boot the plugin writes ONE artifact
 * per LIVE surface id; for 6.3 the live set is [homepage, collection:default].
 * Each write is guarded by `doc?.tree` (draft-only docs must NOT be written),
 * and surfaces not yet live (posttype:default) must NEVER be written.
 */

const TREE = {
  block: "container",
  id: "c_root",
  as: "stack",
  role: "root",
  children: [],
};

const makeDoc = (id, kind) => ({
  _id: id,
  schemaVersion: 4,
  kind,
  status: "published",
  tree: TREE,
  updatedAt: "2026-06-12T08:00:00.000Z",
});

/** Minimal mock db: `collection("compositions").findOne({_id})` from a map. */
const makeDb = (docsById) => ({
  collection: (name) => {
    assert.equal(name, "compositions");
    return {
      findOne: async ({ _id }) => docsById.get(_id) ?? null,
    };
  },
});

test("writes BOTH homepage.json AND collection-default.json when both docs have a published tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "artifacts-"));
  const db = makeDb(
    new Map([
      ["homepage", makeDoc("homepage", "homepage")],
      ["collection:default", makeDoc("collection:default", "collection")],
    ]),
  );

  const written = await writeCompositionArtifacts(db, { outputDir: dir });

  assert.deepEqual(written.sort(), ["collection:default", "homepage"]);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, ["collection-default.json", "homepage.json"]);
  const homepage = JSON.parse(await readFile(join(dir, "homepage.json"), "utf8"));
  assert.equal(homepage.kind, "homepage");
  const listing = JSON.parse(await readFile(join(dir, "collection-default.json"), "utf8"));
  assert.equal(listing.kind, "collection");
});

test("does NOT write a surface whose doc has no published tree (draft-only) — per-doc tree guard preserved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "artifacts-"));
  const draftOnly = makeDoc("collection:default", "collection");
  delete draftOnly.tree; // draft-only: no published tree
  draftOnly.draftTree = { block: "container", id: "c_d", children: [] };
  const db = makeDb(
    new Map([
      ["homepage", makeDoc("homepage", "homepage")],
      ["collection:default", draftOnly],
    ]),
  );

  const written = await writeCompositionArtifacts(db, { outputDir: dir });

  assert.deepEqual(written, ["homepage"]);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, ["homepage.json"]);
});

test("does NOT write a surface whose doc is absent from the db", async () => {
  const dir = await mkdtemp(join(tmpdir(), "artifacts-"));
  const db = makeDb(new Map([["homepage", makeDoc("homepage", "homepage")]]));

  const written = await writeCompositionArtifacts(db, { outputDir: dir });

  assert.deepEqual(written, ["homepage"]);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, ["homepage.json"]);
});

test("DOES write posttype:default — now a live surface (registered in 6.4-T2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "artifacts-"));
  // posttype:default is registered in the SURFACES registry as of 6.4-T2, so a
  // fully-published doc now flows through the registry-derived live set.
  const db = makeDb(
    new Map([
      ["homepage", makeDoc("homepage", "homepage")],
      ["collection:default", makeDoc("collection:default", "collection")],
      ["posttype:default", makeDoc("posttype:default", "postType")],
    ]),
  );

  const written = await writeCompositionArtifacts(db, { outputDir: dir });

  assert.equal(written.includes("posttype:default"), true);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, ["collection-default.json", "homepage.json", "posttype-default.json"]);
});

test("default surface ids derive from the live surface registry (homepage + collection:default + posttype:default)", async () => {
  // No explicit surfaceIds → the helper uses the LIVE registry set. Asserting
  // the default keeps 6.4/6.5 honest: adding a live surface to SURFACES that
  // the helper should write must flow through automatically.
  const dir = await mkdtemp(join(tmpdir(), "artifacts-"));
  const db = makeDb(
    new Map([
      ["homepage", makeDoc("homepage", "homepage")],
      ["collection:default", makeDoc("collection:default", "collection")],
      ["posttype:default", makeDoc("posttype:default", "postType")],
    ]),
  );
  const written = await writeCompositionArtifacts(db, { outputDir: dir });
  assert.deepEqual(written.sort(), ["collection:default", "homepage", "posttype:default"]);
});

test("per-surface error isolation: a failure writing homepage does NOT prevent collection:default", async () => {
  // Inject a writer that THROWS for the first live surface (homepage) but
  // succeeds for the rest. The loop must catch the homepage failure, skip it,
  // and STILL write collection:default — proving each surface is independent.
  const written = [];
  const failingWriter = async (doc) => {
    if (doc._id === "homepage") {
      throw new Error("simulated I/O error writing homepage.json");
    }
    written.push(doc._id);
    return `/fake/${doc._id}.json`;
  };
  const db = makeDb(
    new Map([
      ["homepage", makeDoc("homepage", "homepage")],
      ["collection:default", makeDoc("collection:default", "collection")],
    ]),
  );

  const result = await writeCompositionArtifacts(db, { writer: failingWriter });

  // homepage threw → not in the returned list; collection:default still written.
  assert.deepEqual(result, ["collection:default"]);
  assert.equal(result.includes("homepage"), false);
  assert.deepEqual(written, ["collection:default"]);
});
