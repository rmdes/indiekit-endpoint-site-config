/**
 * Block catalog JSON writer (spec §2.4, §3.1).
 * Renders the discovered block catalog as a JSON string and writes it
 * atomically to disk — the ONLY new production artifact Phase 2 ships.
 * Inert until Phase 3: nothing reads block-catalog.json yet.
 * Path: /app/data/content/_data/block-catalog.json
 *
 * Uses an explicit field whitelist so scanner-internal fields
 * (sourcePlugin, future bookkeeping) never leak into the public artifact —
 * the same deliberate-contract pattern as write-site-json.js. Adding a new
 * public field requires an explicit edit here.
 *
 * Uses tmp-file + rename so the Eleventy watcher never reads a partial file
 * (a direct writeFile races the watcher and can crash the build on
 * JSON.parse). Mirrors the atomic pattern in write-homepage-json.js.
 * @module render/write-block-catalog-json
 */

import { writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

// Whitelisted public fields (spec §2.4: never serialize internals).
const PUBLIC_FIELDS = ["id", "version", "legacy", "label", "description", "icon",
  "category", "placement", "multiple", "schema", "defaultConfig", "data", "render", "aliases"];

/**
 * Render the block catalog as a JSON string suitable for theme consumption.
 *
 * Entries are sorted by id for deterministic output (the scanner already
 * sorts, but the writer must not depend on caller ordering).
 *
 * @param {object[]} entries - Catalog entries (output of scanPlugins().catalog)
 * @returns {string} Pretty-printed JSON source (2-space indent)
 */
export function renderBlockCatalog(entries) {
  const blocks = [...entries]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => {
      const block = {};
      for (const field of PUBLIC_FIELDS) {
        // Object.hasOwn, not `in`: `in` walks the prototype chain, which
        // would let inherited/poisoned properties leak into the artifact.
        if (Object.hasOwn(entry, field)) block[field] = entry[field];
      }
      // requiresPlugin is implied by registration (spec §3.1): built-ins have
      // no sourcePlugin → null (always available); plugin entries stamp their
      // registering endpoint's name. Phase 3 maps this to the theme's
      // loadedPlugins gating.
      block.requiresPlugin = (Object.hasOwn(entry, "sourcePlugin") && entry.sourcePlugin) || null;
      return block;
    });
  return JSON.stringify(
    { catalogVersion: 1, generatedAt: new Date().toISOString(), blocks },
    undefined,
    2,
  );
}

/**
 * Write the block catalog JSON to disk atomically (tmp file → rename).
 * Creates the output directory if it does not exist.
 *
 * The tmp file uses a random suffix so concurrent callers don't collide on a
 * shared tmp name. The rename itself is atomic on POSIX — Eleventy's file
 * watcher will not observe a partial write.
 *
 * @param {object[]} entries - Catalog entries (output of scanPlugins().catalog)
 * @param {string} [outputPath="/app/data/content/_data/block-catalog.json"] - Destination path
 * @returns {Promise<string>} The output path written
 */
export async function writeBlockCatalogJson(
  entries,
  outputPath = "/app/data/content/_data/block-catalog.json",
) {
  await mkdir(dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, renderBlockCatalog(entries), "utf8");
    await rename(tmp, outputPath);
  } catch (error) {
    // Best-effort cleanup — don't leak tmp files into the watched _data dir.
    await unlink(tmp).catch(() => {});
    throw error;
  }
  return outputPath;
}
