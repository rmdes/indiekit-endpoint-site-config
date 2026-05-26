/**
 * Homepage configuration reader.
 * Provides mergeWithHomepageDefaults (pure) and getHomepageConfig (async DB read).
 * @module storage/get-homepage-config
 */

import { DEFAULTS_HOMEPAGE } from "./defaults-homepage.js";
import { deepMerge } from "./get-site-config.js";

/**
 * Merge an input object with homepage defaults.
 * Returns a fully-populated homepage config with all required keys.
 *
 * @param {object} input - Partial homepage config (may be empty)
 * @returns {object} Merged homepage config
 */
export function mergeWithHomepageDefaults(input) {
  return deepMerge(DEFAULTS_HOMEPAGE, input || {});
}

/**
 * Read homepage config from MongoDB, merged with defaults.
 * Returns defaults-only config when no database is configured.
 *
 * @param {object} Indiekit - Indiekit application instance
 * @returns {Promise<object>} Full homepage config
 */
export async function getHomepageConfig(Indiekit) {
  const db = Indiekit.database;
  if (!db) return mergeWithHomepageDefaults({});
  const doc = await db.collection("homepageConfig").findOne({ _id: "homepage" });
  if (!doc) return mergeWithHomepageDefaults({});
  const { _id, ...fields } = doc;
  return mergeWithHomepageDefaults(fields);
}
