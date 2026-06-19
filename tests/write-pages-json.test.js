import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePagesJson } from "../lib/render/write-composition-json.js";

/**
 * 6.5-T4: standalone pages render from a SINGLE `pages.json` ARRAY artifact
 * (NOT one file per page). writePagesJson queries every published `page:<slug>`
 * composition, serializes the PUBLIC_FIELDS shape per page, and writes the
 * array atomically (tmp → rename). Empty published set → `[]` (never a stale
 * or missing file, so the theme loader always sees a fresh array).
 */

const TREE = {
  block: "container",
  id: "c_root",
  as: "stack",
  role: "root",
  children: [],
};

const makePage = (slug, extra = {}) => ({
  _id: `page:${slug}`,
  schemaVersion: 4,
  kind: "page",
  status: "published",
  target: { route: `/${slug}/`, title: slug },
  tree: TREE,
  updatedAt: "2026-06-19T08:00:00.000Z",
  updatedBy: "design-editor",
  draftTree: { block: "container", id: "draft", children: [] },
  draftUpdatedAt: "2026-06-19T09:00:00.000Z",
  ...extra,
});

/**
 * Minimal mock db: `collection("compositions").find(filter).toArray()` returns
 * the docs matching `{ kind, status }`.
 */
const makeDb = (docs) => ({
  collection: (name) => {
    assert.equal(name, "compositions");
    return {
      find: (filter = {}) => ({
        async toArray() {
          return docs.filter((doc) =>
            Object.entries(filter).every(([k, v]) => doc[k] === v),
          );
        },
      }),
    };
  },
});

test("writes an ARRAY of published pages to pages.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pages-"));
  const db = makeDb([makePage("about"), makePage("now")]);
  const path = await writePagesJson(db, dir);
  assert.equal(path, join(dir, "pages.json"));
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.ok(Array.isArray(onDisk), "pages.json is an array");
  assert.equal(onDisk.length, 2);
});

test("each entry carries the PUBLIC_FIELDS shape (target.route/title present)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pages-"));
  const db = makeDb([makePage("about")]);
  await writePagesJson(db, dir);
  const [entry] = JSON.parse(await readFile(join(dir, "pages.json"), "utf8"));
  assert.equal(entry.kind, "page");
  assert.equal(entry.schemaVersion, 4);
  assert.equal(entry.target.route, "/about/");
  assert.equal(entry.target.title, "about");
  assert.deepEqual(entry.tree, TREE);
  assert.equal(entry.updatedAt, "2026-06-19T08:00:00.000Z");
});

test("does NOT include _id or internal fields (draftTree, draftUpdatedAt, updatedBy)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pages-"));
  const db = makeDb([makePage("about")]);
  await writePagesJson(db, dir);
  const [entry] = JSON.parse(await readFile(join(dir, "pages.json"), "utf8"));
  assert.equal("_id" in entry, false);
  assert.equal("draftTree" in entry, false);
  assert.equal("draftUpdatedAt" in entry, false);
  assert.equal("updatedBy" in entry, false);
});

test("excludes draft-only pages — only status:published are written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pages-"));
  const draftOnly = makePage("wip", { status: "draft" });
  delete draftOnly.tree;
  const db = makeDb([makePage("about"), draftOnly]);
  await writePagesJson(db, dir);
  const onDisk = JSON.parse(await readFile(join(dir, "pages.json"), "utf8"));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].target.route, "/about/");
});

test("empty published set → writes `[]` (not a stale/missing file)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pages-"));
  const db = makeDb([]);
  const path = await writePagesJson(db, dir);
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(onDisk, []);
});

test("writes atomically and leaves no tmp files behind on success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pages-"));
  const db = makeDb([makePage("about")]);
  await writePagesJson(db, dir);
  const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("unlinks the tmp file (best-effort) and rethrows when rename fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pages-"));
  // Occupy the target path with a DIRECTORY — rename(file → dir) fails EISDIR.
  await mkdir(join(dir, "pages.json"));
  const db = makeDb([makePage("about")]);
  await assert.rejects(() => writePagesJson(db, dir));
  const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("creates the output directory when it does not exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pages-"));
  const nested = join(dir, "nested", "compositions");
  const db = makeDb([makePage("about")]);
  const path = await writePagesJson(db, nested);
  assert.equal(path, join(nested, "pages.json"));
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(onDisk.length, 1);
});

test("default outputDir is /app/data/content/_data/compositions", async () => {
  const source = await readFile(
    new URL("../lib/render/write-composition-json.js", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes('"/app/data/content/_data/compositions"'));
});

test("boot wiring: index.js imports AND invokes writePagesJson beside writeCompositionArtifacts", async () => {
  // The boot artifact-write block (init's process.nextTick closure) is an inline
  // closure that is not separately exportable without a large refactor; the
  // writer itself is fully unit-tested above. Assert the boot path is wired by
  // source inspection (the same pattern as the default-outputDir test).
  const source = await readFile(new URL("../index.js", import.meta.url), "utf8");
  assert.ok(source.includes("writePagesJson"), "index.js imports writePagesJson");
  assert.ok(
    /writePagesJson\s*\(\s*db\b/.test(source),
    "index.js calls writePagesJson(db, …) at boot",
  );
});
