/**
 * Site configuration writer.
 * Persists a patched config to MongoDB with upsert, merging with defaults.
 * @module storage/save-site-config
 */

import { mergeWithDefaults } from "./get-site-config.js";

/**
 * Save a partial config patch to MongoDB, merged with defaults.
 * Creates the document if it doesn't exist (upsert).
 * Records updatedAt (ISO 8601) and updatedBy on every write.
 *
 * @param {object} Indiekit - Indiekit application instance
 * @param {object} patch - Partial config values to apply
 * @param {string} [userIdentifier] - Identifier of the user making the change
 * @returns {Promise<object>} The fully merged config that was saved
 * @throws {Error} When no database is configured
 */
export async function saveSiteConfig(Indiekit, patch, userIdentifier) {
  const db = Indiekit.application.database;
  if (!db) throw new Error("Database not configured");
  const collection = db.collection("siteConfig");
  const existing = await collection.findOne({ _id: "primary" });
  const merged = mergeWithDefaults({ ...(existing || {}), ...patch });
  merged.updatedAt = new Date().toISOString();
  merged.updatedBy = userIdentifier || "unknown";
  await collection.updateOne(
    { _id: "primary" },
    { $set: merged },
    { upsert: true }
  );
  return merged;
}
