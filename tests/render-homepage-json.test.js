import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHomepageJson } from "../lib/render/write-homepage-json.js";

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "site-config-test-"));
  return { dir, file: join(dir, "homepage.json"), cleanup: () => rmSync(dir, { recursive: true }) };
}

test("writeHomepageJson writes composition shape to file", async () => {
  const { file, cleanup } = tempPath();
  try {
    const config = {
      layout: "two-column",
      hero: { enabled: true, showSocial: false },
      sections: [{ type: "hero", config: {} }],
      sidebar: [],
      blogPostSidebar: [],
      footer: [],
      updatedAt: "2026-05-26T00:00:00.000Z",
    };
    await writeHomepageJson(config, file);
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(written.layout, "two-column");
    assert.equal(written.hero.showSocial, false);
    assert.equal(written.sections.length, 1);
    assert.equal(written.updatedAt, "2026-05-26T00:00:00.000Z");
  } finally {
    cleanup();
  }
});

test("writeHomepageJson no longer emits blogListingSidebar (dissolved into listing surface) but keeps blogPostSidebar", async () => {
  const { file, cleanup } = tempPath();
  try {
    await writeHomepageJson({
      layout: "two-column",
      sections: [],
      sidebar: [],
      blogListingSidebar: [{ type: "search", config: {} }],
      blogPostSidebar: [{ type: "toc", config: {} }],
      footer: [],
      updatedAt: "2026-06-18T00:00:00.000Z",
    }, file);
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal("blogListingSidebar" in written, false);
    assert.ok(Array.isArray(written.blogPostSidebar));
    assert.equal(written.blogPostSidebar[0].type, "toc");
  } finally {
    cleanup();
  }
});

test("writeHomepageJson omits MongoDB-only fields", async () => {
  const { file, cleanup } = tempPath();
  try {
    await writeHomepageJson({
      _id: "homepage",
      updatedBy: "rick",
      layout: "single-column",
      hero: { enabled: false, showSocial: false },
      sections: [], sidebar: [], blogListingSidebar: [],
      blogPostSidebar: [], footer: [],
    }, file);
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(written._id, undefined);
    assert.equal(written.updatedBy, undefined);
  } finally {
    cleanup();
  }
});

test("writeHomepageJson writes valid JSON and leaves no tmp files behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hp-"));
  const out = join(dir, "homepage.json");
  await writeHomepageJson({ layout: "two-column", sections: [], updatedAt: "2026-06-11T00:00:00.000Z" }, out);
  const parsed = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(parsed.layout, "two-column");
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0);
});

test("writeHomepageJson never serializes updatedBy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hp-"));
  const out = join(dir, "homepage.json");
  await writeHomepageJson({ layout: "single-column", updatedBy: "https://me.example/", updatedAt: "x" }, out);
  assert.equal(readFileSync(out, "utf8").includes("updatedBy"), false);
});
