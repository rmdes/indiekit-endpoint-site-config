/**
 * Categories config artifact writer (Category Governance, Layer 2).
 *
 * Writes `content/_data/categories.json` — the build-gating config the Eleventy
 * theme already reads (lib/categories.mjs readCategoryConfig). Shape:
 *   { threshold: number, overrides: { [slug]: { feed?: boolean, listing?: boolean } } }
 *
 * Mirrors write-site-json.js: render (with safe defaults) → mkdir -p → write tmp
 * with random suffix → atomic rename (the Eleventy watcher never sees a partial
 * file). Write failures are surfaced to the caller, which warns-not-crashes on
 * dev machines where /app/data isn't writable.
 *
 * @module render/write-categories-json
 */
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Render the categories artifact JSON from the site config, applying defaults.
 * @param {object} config - the merged site config (expects `config.categories`)
 * @returns {string} pretty JSON
 */
export function renderCategoriesJson(config) {
  const c = (config && config.categories) || {};
  const threshold = Number.isInteger(c.threshold) && c.threshold >= 1 ? c.threshold : 2;
  const overrides = c.overrides && typeof c.overrides === "object" && !Array.isArray(c.overrides) ? c.overrides : {};
  return JSON.stringify({ threshold, overrides }, undefined, 2);
}

/**
 * Atomically write categories.json.
 * @param {object} config - merged site config
 * @param {string} [outputPath]
 * @returns {Promise<string>} the path written
 */
export async function writeCategoriesJson(config, outputPath = "/app/data/content/_data/categories.json") {
  const json = renderCategoriesJson(config);
  await mkdir(dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, json, "utf8");
    await rename(tmp, outputPath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  return outputPath;
}
