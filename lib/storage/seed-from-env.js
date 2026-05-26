import { saveSiteConfig } from "./save-site-config.js";
import { DEFAULTS_HOMEPAGE } from "./defaults-homepage.js";

/**
 * Map env vars to identity fields. Only fields present in env are set.
 * Returns null if NO relevant env vars are set (caller should not seed).
 *
 * Env mapping (v3 identity schema):
 *   - SITE_NAME        → identity.name (preferred)
 *   - AUTHOR_NAME      → identity.name (fallback; only if SITE_NAME unset)
 *   - SITE_DESCRIPTION → identity.description
 *   - SITE_TIMEZONE    → identity.timezone
 *   - SITE_LOCALE      → identity.locale
 *
 * Note: AUTHOR_NAME used to map to a `defaultAuthor` field, but v3
 * removed it. On a personal site the h-card name IS the author name,
 * so both env vars target identity.name. SITE_NAME wins when both set.
 */
function buildIdentityFromEnv() {
  const identity = {};
  if (process.env.SITE_NAME)         identity.name = process.env.SITE_NAME;
  if (process.env.SITE_DESCRIPTION)  identity.description = process.env.SITE_DESCRIPTION;
  if (process.env.AUTHOR_NAME && !identity.name) identity.name = process.env.AUTHOR_NAME;
  if (process.env.SITE_TIMEZONE)     identity.timezone = process.env.SITE_TIMEZONE;
  if (process.env.SITE_LOCALE)       identity.locale = process.env.SITE_LOCALE;
  return Object.keys(identity).length > 0 ? identity : null;
}

/**
 * Seed siteConfig and/or homepageConfig from env vars on first boot.
 *
 * - siteConfig: seeded only if collection is empty AND identity env vars are set.
 * - homepageConfig: seeded with DEFAULTS_HOMEPAGE whenever collection is empty
 *   (no env vars required — composition defaults are always available).
 *
 * Idempotent: skips collections that already have a document.
 *
 * Returns true if EITHER collection was seeded, false otherwise.
 *
 * @param {object} Indiekit - Indiekit application instance
 * @returns {Promise<boolean>}
 */
export async function maybeSeedFromEnv(Indiekit) {
  const db = Indiekit.database;
  if (!db) return false;

  let didSeed = false;

  // Seed siteConfig if empty AND env identity is present
  const existingSite = await db.collection("siteConfig").findOne({ _id: "primary" });
  if (!existingSite) {
    const identity = buildIdentityFromEnv();
    if (identity) {
      await saveSiteConfig(Indiekit, { identity }, "auto-seed-from-env");
      didSeed = true;
    }
  }

  // Seed homepageConfig if empty (always — defaults are env-independent)
  const homepageCollection = db.collection("homepageConfig");
  const existingHomepage = await homepageCollection.findOne({ _id: "homepage" });
  if (!existingHomepage) {
    await homepageCollection.insertOne({
      _id: "homepage",
      ...DEFAULTS_HOMEPAGE,
      updatedAt: new Date().toISOString(),
      updatedBy: "seed-from-env",
    });
    console.log("[site-config] seeded homepageConfig with defaults");
    didSeed = true;
  }

  return didSeed;
}

// Export the helper for testing
export { buildIdentityFromEnv };
