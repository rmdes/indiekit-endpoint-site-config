/**
 * Writes homepageConfig JSON to disk for Eleventy to consume.
 * Path harmonization: /app/data/content/_data/homepage.json (was /.indiekit/).
 * @module render/write-homepage-json
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeHomepageJson(config, outputPath = "/app/data/content/_data/homepage.json") {
  const payload = {
    layout: config.layout,
    hero: config.hero,
    sections: config.sections,
    sidebar: config.sidebar,
    blogListingSidebar: config.blogListingSidebar,
    blogPostSidebar: config.blogPostSidebar,
    footer: config.footer,
    updatedAt: config.updatedAt,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");
  return outputPath;
}
