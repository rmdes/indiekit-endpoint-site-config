/**
 * Site configuration reader and merger.
 * Provides mergeWithDefaults (pure) and getSiteConfig (async DB read).
 * @module storage/get-site-config
 */

import { DEFAULTS } from "./defaults.js";

/**
 * Deep-merge source into target, returning a new object.
 * Arrays are replaced (not concatenated).
 * null values are treated as scalars (not objects to merge into).
 *
 * @param {object} target - Base object (e.g. DEFAULTS)
 * @param {object} source - Override object
 * @returns {object} New merged object
 */
export function deepMerge(target, source) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const key of Object.keys(source || {})) {
    const srcVal = source[key];
    const tgtVal = out[key];
    if (
      srcVal &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      out[key] = deepMerge(tgtVal, srcVal);
    } else if (srcVal !== undefined) {
      out[key] = srcVal;
    }
  }
  return out;
}

/**
 * Merge an input object with defaults.
 * Returns a fully-populated config with all required keys.
 *
 * @param {object} input - Partial config (may be empty)
 * @returns {object} Merged config
 */
export function mergeWithDefaults(input) {
  return deepMerge(DEFAULTS, input || {});
}

/**
 * Read site config from MongoDB, merged with defaults.
 * Returns defaults-only config when no database is configured.
 *
 * @param {object} Indiekit - Indiekit application instance
 * @returns {Promise<object>} Full site config
 */
export async function getSiteConfig(Indiekit) {
  const db = Indiekit.application.database;
  if (!db) return mergeWithDefaults({});
  const doc = await db.collection("siteConfig").findOne({ _id: "primary" });
  if (!doc) return mergeWithDefaults({});
  const { _id, ...fields } = doc;
  return mergeWithDefaults(fields);
}
