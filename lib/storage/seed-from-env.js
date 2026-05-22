import { saveSiteConfig } from "./save-site-config.js";

/**
 * Map env vars to identity fields. Only fields present in env are set.
 * Returns null if NO relevant env vars are set (caller should not seed).
 */
function buildIdentityFromEnv() {
  const identity = {};
  if (process.env.SITE_NAME)         identity.name = process.env.SITE_NAME;
  if (process.env.SITE_DESCRIPTION)  identity.description = process.env.SITE_DESCRIPTION;
  if (process.env.AUTHOR_NAME)       identity.defaultAuthor = process.env.AUTHOR_NAME;
  if (process.env.SITE_TIMEZONE)     identity.timezone = process.env.SITE_TIMEZONE;
  if (process.env.SITE_LOCALE)       identity.locale = process.env.SITE_LOCALE;
  return Object.keys(identity).length > 0 ? identity : null;
}

/**
 * If MongoDB has no siteConfig AND env vars are present, seed siteConfig
 * from env vars. Idempotent — does nothing if siteConfig already exists.
 *
 * Returns true if a seed was performed, false otherwise.
 *
 * @param {object} Indiekit - Indiekit application instance
 * @returns {Promise<boolean>}
 */
export async function maybeSeedFromEnv(Indiekit) {
  const db = Indiekit.database;
  if (!db) return false;

  const existing = await db.collection("siteConfig").findOne({ _id: "primary" });
  if (existing) return false;

  const identity = buildIdentityFromEnv();
  if (!identity) return false;

  await saveSiteConfig(Indiekit, { identity }, "auto-seed-from-env");
  return true;
}

// Export the helper for testing
export { buildIdentityFromEnv };
