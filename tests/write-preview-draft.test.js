import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writePreviewDraft,
  previewDraftFile,
} from "../lib/render/write-preview-draft.js";

const TREE = {
  block: "container",
  id: "c_root",
  as: "stack",
  role: "root",
  children: [
    { block: "section", id: "b_1", type: "recent-posts", v: 1, config: { maxItems: 5 } },
  ],
};

const INPUT = { surface: "homepage", tree: TREE, revision: 3, token: "tok_abc123" };

test("writes EXACTLY the spec §2.4 preview shape (schemaVersion 4, kind preview, surface)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-draft-"));
  const path = await writePreviewDraft(INPUT, dir);
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(
    Object.keys(onDisk).sort(),
    ["generatedAt", "kind", "revision", "schemaVersion", "surface", "token", "tree"],
  );
  assert.equal(onDisk.schemaVersion, 4);
  assert.equal(onDisk.kind, "preview");
  assert.equal(onDisk.surface, "homepage");
  assert.equal(onDisk.revision, 3);
  assert.equal(onDisk.token, "tok_abc123");
  assert.deepEqual(onDisk.tree, TREE);
});

test("stamps the surface routeKey into the artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-draft-"));
  for (const surface of ["homepage", "listing", "posttype"]) {
    const path = await writePreviewDraft({ ...INPUT, surface }, dir);
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    assert.equal(onDisk.surface, surface);
  }
});

test("extra input fields can never leak (artifact is built, not picked)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-draft-"));
  const path = await writePreviewDraft(
    { ...INPUT, _id: "primary", draftTree: {}, secretInternal: "never" },
    dir,
  );
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.equal("_id" in onDisk, false);
  assert.equal("draftTree" in onDisk, false);
  assert.equal("secretInternal" in onDisk, false);
});

test("generatedAt is an ISO 8601 string (workspace date convention), injectable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-draft-"));
  const fixed = "2026-06-12T10:00:00.000Z";
  const path = await writePreviewDraft(INPUT, dir, { now: () => fixed });
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(onDisk.generatedAt, fixed);

  const real = await writePreviewDraft(INPUT, dir);
  const realOnDisk = JSON.parse(await readFile(real, "utf8"));
  assert.equal(typeof realOnDisk.generatedAt, "string");
  assert.ok(realOnDisk.generatedAt.match(/^\d{4}-\d{2}-\d{2}T.*Z$/));
});

test("writes to <outputDir>/preview-<surface>.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-draft-"));
  const path = await writePreviewDraft(INPUT, dir);
  assert.equal(path, join(dir, "preview-homepage.json"));
  assert.equal(previewDraftFile("homepage"), "preview-homepage.json");
  assert.equal(previewDraftFile("listing"), "preview-listing.json");
  assert.equal(previewDraftFile("posttype"), "preview-posttype.json");
});

test("different surfaces write DIFFERENT files (no overwrite)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-draft-"));
  const homepagePath = await writePreviewDraft(
    { ...INPUT, surface: "homepage", revision: 1 },
    dir,
  );
  const listingPath = await writePreviewDraft(
    { ...INPUT, surface: "listing", revision: 2 },
    dir,
  );
  assert.notEqual(homepagePath, listingPath);

  // Writing listing did NOT clobber homepage's file.
  const homepageOnDisk = JSON.parse(await readFile(homepagePath, "utf8"));
  const listingOnDisk = JSON.parse(await readFile(listingPath, "utf8"));
  assert.equal(homepageOnDisk.surface, "homepage");
  assert.equal(homepageOnDisk.revision, 1);
  assert.equal(listingOnDisk.surface, "listing");
  assert.equal(listingOnDisk.revision, 2);

  // Both files coexist on disk.
  const files = (await readdir(dir)).sort();
  assert.deepEqual(files, ["preview-homepage.json", "preview-listing.json"]);
});

test("default outputDir is /app/data/content/_data/compositions", async () => {
  // Assert via the function signature default — we must not write to /app in tests.
  const source = await readFile(
    new URL("../lib/render/write-preview-draft.js", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes('"/app/data/content/_data/compositions"'));
});

test("writes atomically and leaves no tmp files behind on success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-draft-"));
  await writePreviewDraft(INPUT, dir);
  const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("unlinks the tmp file (best-effort) and rethrows when rename fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-draft-"));
  // Simulate rename failure: occupy the target path with a DIRECTORY —
  // rename(file → existing directory) fails with EISDIR on POSIX.
  await mkdir(join(dir, previewDraftFile("homepage")));
  await assert.rejects(() => writePreviewDraft(INPUT, dir));
  const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []); // tmp cleaned up despite the failure
});

test("creates the output directory when it does not exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-draft-"));
  const nested = join(dir, "nested", "compositions");
  const path = await writePreviewDraft(INPUT, nested);
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(onDisk.kind, "preview");
});
