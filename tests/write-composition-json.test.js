import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCompositionJson, surfaceFileName } from "../lib/render/write-composition-json.js";

const TREE = {
  id: "root",
  type: "container",
  variant: "stack",
  children: [
    {
      id: "b1",
      type: "block",
      block: "latest-posts",
      version: 1,
      config: { count: 5 },
    },
  ],
};

const DOC = {
  _id: "homepage",
  schemaVersion: 4,
  kind: "homepage",
  target: {},
  status: "published",
  tree: TREE,
  updatedAt: "2026-06-12T08:00:00.000Z",
  updatedBy: "migrate-v3-to-v4",
  draftTree: { id: "draft-root", type: "container", children: [] },
  draftUpdatedAt: "2026-06-12T09:00:00.000Z",
  secretInternal: "never-serialize-me",
};

test("serializes ONLY the public whitelist (spec §2.4 excludes updatedBy, _id, draftTree, draftUpdatedAt)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "composition-"));
  const path = await writeCompositionJson(DOC, dir);
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(
    Object.keys(onDisk).sort(),
    ["kind", "schemaVersion", "status", "target", "tree", "updatedAt"],
  );
  assert.equal("_id" in onDisk, false);
  assert.equal("updatedBy" in onDisk, false);
  assert.equal("draftTree" in onDisk, false);
  assert.equal("draftUpdatedAt" in onDisk, false);
  assert.equal("secretInternal" in onDisk, false);
});

test("does not serialize fields inherited from the prototype chain", async () => {
  const proto = { status: "published-from-prototype" };
  const { status: _drop, ...rest } = DOC;
  const doc = Object.assign(Object.create(proto), rest);
  const dir = await mkdtemp(join(tmpdir(), "composition-"));
  const path = await writeCompositionJson(doc, dir);
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  // `status` only exists on the prototype — Object.hasOwn must reject it.
  assert.equal("status" in onDisk, false);
  assert.equal(onDisk.kind, "homepage");
});

test("writes atomically and leaves no tmp files behind on success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "composition-"));
  await writeCompositionJson(DOC, dir);
  const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("unlinks the tmp file (best-effort) and rethrows when rename fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "composition-"));
  // Simulate rename failure: occupy the target path with a DIRECTORY —
  // rename(file → existing directory) fails with EISDIR on POSIX.
  await mkdir(join(dir, "homepage.json"));
  await assert.rejects(() => writeCompositionJson(DOC, dir));
  const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []); // tmp cleaned up despite the failure
});

test("surfaceFileName maps surface ids to file names (colon → dash, spec §2.4)", () => {
  assert.equal(surfaceFileName("homepage"), "homepage");
  assert.equal(surfaceFileName("collection:default"), "collection-default");
  assert.equal(surfaceFileName("posttype:default"), "posttype-default");
});

test("surfaceFileName preserves the existing singleton + page names (no hardening regression)", () => {
  assert.equal(surfaceFileName("homepage"), "homepage");
  assert.equal(surfaceFileName("collection:default"), "collection-default");
  assert.equal(surfaceFileName("posttype:default"), "posttype-default");
  assert.equal(surfaceFileName("page:cv"), "page-cv");
  assert.equal(surfaceFileName("page:about-me"), "page-about-me");
});

test("surfaceFileName REJECTS a traversal-crafted id (defense-in-depth — SECURITY LOW)", () => {
  // A crafted `_id` with slashes/dots would escape the output dir if only
  // colons were replaced (`page:../../passwd` → `page-../../passwd`). The guard
  // must throw rather than return a name containing path separators or `..`.
  assert.throws(() => surfaceFileName("page:../../passwd"));
  assert.throws(() => surfaceFileName("page:../../etc/passwd"));
  assert.throws(() => surfaceFileName("a/b"));
  assert.throws(() => surfaceFileName("..%2f..%2fx"));
});

test("surfaceFileName result never contains a path separator or parent ref", () => {
  // For every accepted id, the result is a single safe path segment.
  for (const id of ["homepage", "collection:default", "posttype:default", "page:cv", "page:about-me"]) {
    const name = surfaceFileName(id);
    assert.equal(name.includes("/"), false, `${id} → ${name} has no slash`);
    assert.equal(name.includes("\\"), false, `${id} → ${name} has no backslash`);
    assert.equal(name.includes(".."), false, `${id} → ${name} has no parent ref`);
  }
});

test("writes to <outputDir>/<surfaceFileName(doc._id)>.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "composition-"));
  const doc = { ...DOC, _id: "collection:default", kind: "collection", target: { collection: "default" } };
  const path = await writeCompositionJson(doc, dir);
  assert.equal(path, join(dir, "collection-default.json"));
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(onDisk.kind, "collection");
});

test("default outputDir is /app/data/content/_data/compositions", async () => {
  // Assert via the function signature default — we must not write to /app in tests.
  const source = await readFile(
    new URL("../lib/render/write-composition-json.js", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes('"/app/data/content/_data/compositions"'));
});

test("round-trip: written file parses, tree deep-equals input, updatedAt ISO string preserved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "composition-"));
  const path = await writeCompositionJson(DOC, dir);
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(onDisk.tree, TREE);
  assert.equal(onDisk.updatedAt, "2026-06-12T08:00:00.000Z");
  assert.ok(onDisk.updatedAt.match(/^\d{4}-\d{2}-\d{2}T/)); // ISO string (workspace convention)
  assert.equal(onDisk.schemaVersion, 4);
  assert.deepEqual(onDisk.target, {});
});

test("creates the output directory when it does not exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "composition-"));
  const nested = join(dir, "nested", "compositions");
  const path = await writeCompositionJson(DOC, nested);
  assert.equal(path, join(nested, "homepage.json"));
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(onDisk.kind, "homepage");
});
