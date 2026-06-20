import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteCategoryFrontmatter } from "../lib/storage/category-merge.js";

const fm = (body) => `---\n${body}\n---\nThe body stays exactly as-is.\nLine two.\n`;

test("inline form: renames the category scalar", () => {
  const input = fm("date: 2026-02-05T16:52:41.754Z\ncategory: Politics");
  const { content, changed } = rewriteCategoryFrontmatter(input, { Politics: "politics" });
  assert.equal(changed, true);
  assert.equal(content, fm("date: 2026-02-05T16:52:41.754Z\ncategory: politics"));
});

test("inline form: no match → unchanged, changed:false (byte-identical)", () => {
  const input = fm("date: 2026-02-05T16:52:41.754Z\ncategory: roadmap");
  const out = rewriteCategoryFrontmatter(input, { Politics: "politics" });
  assert.equal(out.changed, false);
  assert.equal(out.content, input);
});

test("block-array form: renames matching items, leaves others (incl URLs)", () => {
  const input = fm("date: x\ncategory:\n  - Politics\n  - random\n  - https://bsky.app/x");
  const { content, changed } = rewriteCategoryFrontmatter(input, { Politics: "politics" });
  assert.equal(changed, true);
  assert.equal(content, fm("date: x\ncategory:\n  - politics\n  - random\n  - https://bsky.app/x"));
});

test("block-array form: dedupes when two casings merge to one", () => {
  const input = fm("category:\n  - Politics\n  - politics\n  - AI");
  const { content, changed } = rewriteCategoryFrontmatter(input, { Politics: "politics" });
  assert.equal(changed, true);
  assert.equal(content, fm("category:\n  - politics\n  - AI"));
});

test("preserves all other frontmatter fields + body byte-for-byte", () => {
  const input = fm("aiTextLevel: \"0\"\nmpUrl: https://x/y/\ndate: 2026-06-17T06:38:47.574+01:00\nlayout: layouts/post.njk\ncategory: Test\noriginal_url: https://blog/x.html");
  const { content } = rewriteCategoryFrontmatter(input, { Test: "test" });
  assert.equal(content, fm("aiTextLevel: \"0\"\nmpUrl: https://x/y/\ndate: 2026-06-17T06:38:47.574+01:00\nlayout: layouts/post.njk\ncategory: test\noriginal_url: https://blog/x.html"));
});

test("no category field → unchanged", () => {
  const input = fm("date: x\ntitle: no category here");
  const out = rewriteCategoryFrontmatter(input, { Politics: "politics" });
  assert.equal(out.changed, false);
  assert.equal(out.content, input);
});

test("no frontmatter block → unchanged", () => {
  const input = "Just a body, no frontmatter.\n";
  const out = rewriteCategoryFrontmatter(input, { Politics: "politics" });
  assert.equal(out.changed, false);
  assert.equal(out.content, input);
});

test("rename map with multiple keys applies all", () => {
  const input = fm("category:\n  - Politics\n  - AI\n  - tech");
  const { content } = rewriteCategoryFrontmatter(input, { Politics: "politics", AI: "ai" });
  assert.equal(content, fm("category:\n  - politics\n  - ai\n  - tech"));
});

test("preserves CRLF line endings", () => {
  const input = "---\r\ncategory: Politics\r\n---\r\nbody\r\n";
  const { content } = rewriteCategoryFrontmatter(input, { Politics: "politics" });
  assert.equal(content, "---\r\ncategory: politics\r\n---\r\nbody\r\n");
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCategoryMerge, syncMongoCategories } from "../lib/storage/category-merge.js";

test("applyCategoryMerge rewrites matching .md files recursively (db=null)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "a.md"), "---\ncategory: Politics\n---\nbody\n");
  writeFileSync(join(dir, "notes", "b.md"), "---\ncategory:\n  - Politics\n  - politics\n---\nbody\n");
  writeFileSync(join(dir, "c.md"), "---\ncategory: AI\n---\nbody\n"); // not in map
  const res = await applyCategoryMerge(dir, null, { Politics: "politics" });
  assert.equal(res.filesChanged, 2);
  assert.equal(readFileSync(join(dir, "a.md"), "utf8"), "---\ncategory: politics\n---\nbody\n");
  assert.equal(readFileSync(join(dir, "notes", "b.md"), "utf8"), "---\ncategory:\n  - politics\n---\nbody\n");
  assert.equal(readFileSync(join(dir, "c.md"), "utf8"), "---\ncategory: AI\n---\nbody\n");
  rmSync(dir, { recursive: true, force: true });
});

test("syncMongoCategories renames + dedupes posts docs (mock db)", async () => {
  const docs = [
    { _id: 1, properties: { category: ["Politics", "politics", "AI"] } },
    { _id: 2, properties: { category: "Politics" } },
  ];
  const updates = [];
  const db = {
    collection: () => ({
      find: (q) => {
        const names = q["properties.category"].$in;
        const matched = docs.filter((d) => {
          const c = d.properties.category;
          return Array.isArray(c) ? c.some((x) => names.includes(x)) : names.includes(c);
        });
        return { async *[Symbol.asyncIterator]() { for (const d of matched) yield d; } };
      },
      updateOne: async (filter, update) => updates.push({ id: filter._id, set: update.$set["properties.category"] }),
    }),
  };
  const n = await syncMongoCategories(db, { Politics: "politics" });
  assert.equal(n, 2);
  assert.deepEqual(updates.find((u) => u.id === 1).set, ["politics", "AI"]);
  assert.equal(updates.find((u) => u.id === 2).set, "politics");
});

test("block-array: single-quoted malformed item renamed (the RSS bug)", () => {
  const input = fm("category:\n  - '[\"RSS\"]'");
  const { content, changed } = rewriteCategoryFrontmatter(input, { '["RSS"]': "RSS" });
  assert.equal(changed, true);
  assert.equal(content, fm("category:\n  - RSS"));
});

test("block-array: double-quoted item renamed", () => {
  const input = fm('category:\n  - "AI"');
  const { content } = rewriteCategoryFrontmatter(input, { AI: "ai" });
  assert.equal(content, fm("category:\n  - ai"));
});

test("inline: single-quoted value renamed", () => {
  const input = fm("category: 'My Topic'");
  const { content, changed } = rewriteCategoryFrontmatter(input, { "My Topic": "topic" });
  assert.equal(changed, true);
  assert.equal(content, fm("category: topic"));
});

test("renamed value needing quotes gets requoted", () => {
  const input = fm("category: Foo");
  const { content } = rewriteCategoryFrontmatter(input, { Foo: "a: b" });
  assert.equal(content, fm('category: "a: b"'));
});

test("unchanged quoted array item preserved byte-for-byte", () => {
  const input = fm("category:\n  - 'keep me'\n  - Politics");
  const { content } = rewriteCategoryFrontmatter(input, { Politics: "politics" });
  assert.equal(content, fm("category:\n  - 'keep me'\n  - politics"));
});
