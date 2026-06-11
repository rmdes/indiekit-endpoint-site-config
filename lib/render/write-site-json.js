/**
 * Site config JSON writer.
 * Renders a site config object as a JSON string for Eleventy consumption,
 * and optionally writes it atomically to disk.
 *
 * The JSON is consumed by Eleventy via `_data/site-config.json`. Template
 * authors access fields like `{{ site.identity.name }}` and
 * `{{ site.branding.colors.primary }}` in Nunjucks templates.
 *
 * The renderer uses an explicit top-level whitelist of v3 schema fields so
 * legacy subtrees (e.g. v2's `layout.*`) on old MongoDB documents are dropped
 * at serialization. Adding a new top-level key requires an explicit edit
 * here — a deliberate contract change, not an accident. The PRIVATE_KEYS
 * replacer still strips `updatedBy`/`savedBy` at any depth for PII safety
 * inside nested structures like `branding.history[*]`.
 *
 * @module render/write-site-json
 */

import { writeFile, rename, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

// Keys that must never appear in the public Eleventy data layer.
// updatedBy may contain a user email or profile URL (PII).
// savedBy (inside branding.history entries) is the same — see spec §11.2.
// We strip by key name at any depth so future nested fields are safe by default.
const PRIVATE_KEYS = new Set(["updatedBy", "savedBy"]);

/**
 * Render the site config as a JSON string suitable for Eleventy consumption.
 *
 * Uses an explicit top-level whitelist of v3 schema fields so any legacy
 * subtree (e.g. v2's `layout.*`) on an old MongoDB document is dropped at
 * serialization. The PRIVATE_KEYS replacer still strips `updatedBy` and
 * `savedBy` at any depth (PII safety inside branding.history entries, etc.).
 *
 * `updatedAt` (a timestamp) is intentionally kept — template authors may want
 * to display "site last updated YYYY-MM-DD" using this field.
 *
 * @param {object} config - Merged site config object (output of mergeWithDefaults)
 * @returns {string} Pretty-printed JSON source (2-space indent)
 */
export function renderSiteJson(config) {
  // Drop `branding.history` (up to 10 full palette snapshots) from the public
  // artifact: it bloats site-config.json by 10-20KB and exposes design
  // iteration history that templates never consume. The PRIVATE_KEYS replacer
  // below still strips savedBy/updatedBy at depth for any other nested PII.
  const { history: _history, ...brandingPublic } = config.branding || {};
  const payload = {
    schemaVersion: config.schemaVersion,
    identity:      config.identity,
    branding:      brandingPublic,
    navigation:    config.navigation,
    features:      config.features,
    updatedAt:     config.updatedAt,
  };
  const replacer = (key, value) => (PRIVATE_KEYS.has(key) ? undefined : value);
  return JSON.stringify(payload, replacer, 2);
}

/**
 * Write the site config JSON to disk atomically (tmp file → rename).
 * Creates the output directory if it does not exist.
 *
 * The tmp file uses a random suffix so concurrent callers don't collide on a
 * shared tmp name (two simultaneous writes both renaming the same file would
 * cause one to fail with ENOENT). The rename itself is atomic on POSIX —
 * Eleventy's file watcher will not observe a partial write.
 *
 * @param {object} config - Full site config (from mergeWithDefaults)
 * @param {string} [outputPath="/app/data/content/_data/site-config.json"] - Destination path
 * @returns {Promise<void>}
 */
export async function writeSiteJson(
  config,
  outputPath = "/app/data/content/_data/site-config.json",
) {
  const json = renderSiteJson(config);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, json, "utf8");
  await rename(tmp, outputPath);
}
