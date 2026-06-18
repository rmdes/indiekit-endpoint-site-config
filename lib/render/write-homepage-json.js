/**
 * Writes homepageConfig JSON to disk for Eleventy to consume — ATOMICALLY.
 * Path: /app/data/content/_data/homepage.json
 *
 * Uses tmp-file + rename so the Eleventy watcher never reads a partial file
 * (a direct writeFile races the watcher and can crash the build on JSON.parse).
 * Mirrors the atomic pattern in write-site-json.js.
 * @module render/write-homepage-json
 */

import { writeFile, rename, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export async function writeHomepageJson(config, outputPath = "/app/data/content/_data/homepage.json") {
  const payload = {
    layout: config.layout,
    hero: config.hero,
    sections: config.sections,
    sidebar: config.sidebar,
    // 6.3-T7: blogListingSidebar dissolved into the listing surface
    // (collection-default.json composition artifact) — no longer emitted here.
    // 6.4-T4: blogPostSidebar likewise dissolved into the postType surface
    // (posttype-default.json composition artifact) — the blog tab is gone and
    // the theme reads the composition artifact, not homepage.json. The
    // homepageConfig.blogPostSidebar STORAGE field is retained for the
    // one-time re-seed; it just no longer reaches this artifact.
    footer: config.footer,
    updatedAt: config.updatedAt,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmp, outputPath);
  return outputPath;
}
