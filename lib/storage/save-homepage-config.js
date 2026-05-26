/**
 * Homepage configuration writer.
 * Persists a patched homepage config to MongoDB with upsert, merging with defaults.
 * @module storage/save-homepage-config
 */

import { mergeWithHomepageDefaults } from "./get-homepage-config.js";
import { deepMerge } from "./get-site-config.js";

/**
 * Save a partial homepage config patch to MongoDB, merged with defaults.
 * Creates the document if it doesn't exist (upsert).
 * Records updatedAt (ISO 8601) and updatedBy on every write.
 *
 * Uses deepMerge against the existing document so partial-section patches
 * (e.g. { hero: { enabled: false } }) do not erase sibling fields.
 * Uses replaceOne to match sibling plugin convention and avoid MongoDB's
 * "Mod on _id not allowed" error from $set on a doc containing _id.
 *
 * @param {object} Indiekit - Indiekit application instance
 * @param {object} patch - Partial homepage config values to apply
 * @param {string} [userIdentifier] - Identifier of the user making the change
 * @returns {Promise<object>} The fully merged homepage config that was saved
 * @throws {Error} When no database is configured
 */
export async function saveHomepageConfig(Indiekit, patch, userIdentifier) {
  const db = Indiekit.database;
  if (!db) throw new Error("Database not configured");
  const collection = db.collection("homepageConfig");
  const existing = await collection.findOne({ _id: "homepage" });
  const { _id, ...existingFields } = existing || {};
  const merged = mergeWithHomepageDefaults(deepMerge(existingFields, patch));
  merged.updatedAt = new Date().toISOString();
  merged.updatedBy = userIdentifier || "unknown";
  await collection.replaceOne(
    { _id: "homepage" },
    { _id: "homepage", ...merged },
    { upsert: true }
  );
  return merged;
}
