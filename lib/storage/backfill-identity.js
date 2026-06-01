/**
 * One-time backfill: copy homepageConfig.identity → siteConfig.identity
 * when the latter is empty/stub.
 *
 * The legacy @rmdes/indiekit-endpoint-homepage plugin persisted identity
 * inside the homepageConfig collection. The unified plugin reads identity
 * from siteConfig.identity. Without a backfill, operators upgrading from
 * homepage v1.0.24 → site-config v1.0.0-beta.2 would see an empty Identity
 * tab even though the data is sitting one collection over.
 *
 * Heuristic for "empty/stub": none of name, avatar, bio populated.
 * If those three are all empty/missing, we consider the identity stub-shaped
 * and backfill from homepageConfig.identity if a richer version exists.
 *
 * Idempotent: once siteConfig.identity has data, the function no-ops.
 *
 * @module storage/backfill-identity
 */

import { saveSiteConfig } from "./save-site-config.js";

function isStubIdentity(identity) {
  if (!identity || typeof identity !== "object") return true;
  // The three load-bearing h-card fields. If none populated, treat as stub.
  const name = (identity.name || "").trim();
  const avatar = (identity.avatar || "").trim();
  const bio = (identity.bio || "").trim();
  return name === "" && avatar === "" && bio === "";
}

function hasRichIdentity(identity) {
  if (!identity || typeof identity !== "object") return false;
  // Source must have at least one of the three load-bearing fields
  return Boolean(
    (identity.name || "").trim() ||
    (identity.avatar || "").trim() ||
    (identity.bio || "").trim()
  );
}

/**
 * If siteConfig.identity is stub-shaped AND homepageConfig.identity has
 * rich data, copy the rich identity over. Idempotent.
 *
 * @param {object} Indiekit - Indiekit application instance
 * @returns {Promise<boolean>} true if backfill ran, false otherwise
 */
export async function maybeBackfillIdentity(Indiekit) {
  const db = Indiekit.database;
  if (!db) return false;

  const siteDoc = await db.collection("siteConfig").findOne({ _id: "primary" });
  if (!siteDoc) return false; // seed-from-env handles greenfield install
  if (!isStubIdentity(siteDoc.identity)) return false;

  const homepageDoc = await db.collection("homepageConfig").findOne({ _id: "homepage" });
  if (!homepageDoc || !hasRichIdentity(homepageDoc.identity)) return false;

  // Copy the rich identity over. saveSiteConfig handles the deepMerge + replaceOne
  // so we preserve any other siteConfig keys (branding, navigation).
  await saveSiteConfig(Indiekit, { identity: homepageDoc.identity }, "backfill-from-homepage");

  console.log("[site-config] backfilled identity from homepageConfig (one-time migration)");
  return true;
}
