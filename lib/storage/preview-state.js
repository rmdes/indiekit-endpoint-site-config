/**
 * Per-surface preview token + revision lifecycle (#32, design D1) — stored as
 * a map keyed by **routeKey** on the siteConfig doc:
 *
 *   previews: { homepage: {token, revision}, listing: {...}, posttype: {...} }
 *
 * Each surface owns an ISOLATED preview slot so previewing/publishing one
 * surface never clobbers another's token or revision. RouteKeys are colon-free
 * (`"homepage"`, `"listing"`, `"posttype"`) precisely so they are safe Mongo
 * field names usable in the dotted paths `previews.<routeKey>.token` /
 * `previews.<routeKey>.revision`.
 *
 * THE TOKEN: 16 random bytes, base64url (≈22 chars) — an unguessable-path
 * token for `/preview/<routeKey>/<token>/`, ephemeral defense-in-depth. It is
 * NEVER an IndieAuth token and must never be logged. Rotated unconditionally
 * on every publish so previously shared preview URLs expire (the old URL dies
 * on the next rebuild — intentional, per-publish rotation policy).
 *
 * THE REVISION: a per-surface monotonic integer bumped on every preview-draft
 * write. The theme's preview page embeds it (`data-preview-revision`); the
 * editor polls the iframe until the just-written revision shows up.
 *
 * LEGACY MIGRATION (seed-if-absent, non-destructive): before per-surface, a
 * single shared slot lived in flat `previewToken`/`previewRevision` fields and
 * only the homepage surface used it. To keep the LIVE homepage preview token
 * and revision stable across the upgrade, every operation lazily migrates
 * those flat fields into `previews.homepage` ON FIRST TOUCH of the homepage
 * surface — but ONLY when `previews.homepage` is absent (so an already-migrated
 * slot, or a stale flat field left behind, can never clobber the live slot).
 * The flat fields are left in place (non-destructive); `previews.homepage` is
 * authoritative once it exists.
 *
 * ATOMICITY: field-level updates only ($set / $setOnInsert / $inc — never a
 * whole-doc replace), matching the composition-draft.js convention.
 * ensureToken is read-back-after-atomic-write so concurrent boots/requests
 * always converge on the single persisted token, never two.
 *
 * @module storage/preview-state
 */

import { randomBytes } from "node:crypto";

const SITE_CONFIG_ID = "primary";
const HOMEPAGE_ROUTE_KEY = "homepage";

const defaultRandom = () => randomBytes(16).toString("base64url");

const tokenPath = (routeKey) => `previews.${routeKey}.token`;
const revisionPath = (routeKey) => `previews.${routeKey}.revision`;

/**
 * Lazily migrate the legacy flat single-slot (`previewToken`/`previewRevision`)
 * into `previews.homepage`, seed-if-absent and non-destructive.
 *
 * Only fires for the homepage surface, only when the legacy fields exist AND
 * `previews.homepage` does not (a `previews.homepage.token: { $exists: false }`
 * filter guards against clobbering an already-migrated slot — exactly one
 * concurrent caller matches; the flat fields are never removed). A no-op for
 * non-homepage surfaces, for docs without legacy fields, and for docs already
 * carrying `previews.homepage`.
 *
 * @param {object} siteConfig siteConfig collection handle
 * @param {string} routeKey
 * @param {object|null} doc The current doc (pre-read by the caller), or null
 * @returns {Promise<void>}
 */
async function maybeMigrateLegacyHomepage(siteConfig, routeKey, doc) {
  if (routeKey !== HOMEPAGE_ROUTE_KEY) return;
  if (!doc) return;
  if (doc.previewToken === undefined && doc.previewRevision === undefined) {
    return;
  }
  if (doc.previews?.homepage !== undefined) return; // already migrated

  await siteConfig.updateOne(
    { _id: SITE_CONFIG_ID, [tokenPath(HOMEPAGE_ROUTE_KEY)]: { $exists: false } },
    {
      $set: {
        [tokenPath(HOMEPAGE_ROUTE_KEY)]: doc.previewToken ?? null,
        [revisionPath(HOMEPAGE_ROUTE_KEY)]: doc.previewRevision ?? 0,
      },
    },
  );
}

/**
 * Read a surface's preview state from the siteConfig doc, migrating a legacy
 * homepage slot on read when needed.
 *
 * @param {object} db MongoDB database handle (`collection(name)`)
 * @param {string} routeKey Surface route key (`"homepage"` | `"listing"` | …)
 * @returns {Promise<{ token: string | null, revision: number }>}
 */
export async function getPreviewState(db, routeKey) {
  const siteConfig = db.collection("siteConfig");
  const doc = await siteConfig.findOne({ _id: SITE_CONFIG_ID });
  // A homepage migration may have just seeded previews.homepage; re-read so the
  // returned state reflects the migrated slot (only when migration could fire).
  const mayHaveMigrated =
    routeKey === HOMEPAGE_ROUTE_KEY &&
    doc?.previews?.homepage === undefined &&
    (doc?.previewToken !== undefined || doc?.previewRevision !== undefined);
  await maybeMigrateLegacyHomepage(siteConfig, routeKey, doc);
  const fresh = mayHaveMigrated
    ? ((await siteConfig.findOne({ _id: SITE_CONFIG_ID })) ?? doc)
    : doc;
  const slot = fresh?.previews?.[routeKey];
  return {
    token: slot?.token ?? null,
    revision: slot?.revision ?? 0,
  };
}

/**
 * Return a surface's persisted preview token, generating one atomically when
 * absent. Same atomic posture as before, now on the dotted path:
 *
 * (1) $setOnInsert via upsert covers the no-doc case (a concurrent upsert race
 * surfaces as a duplicate _id error — swallowed, the doc now exists either
 * way); (2) a `$exists`-filtered $set on `previews.<routeKey>.token` covers a
 * pre-existing doc that lacks the slot (exactly one concurrent caller
 * matches). The read-back is authoritative, so every concurrent caller returns
 * the SAME persisted token — never two.
 *
 * For the homepage surface, the legacy flat slot is migrated first so the live
 * token is returned unchanged rather than a freshly generated one.
 *
 * @param {object} db
 * @param {string} routeKey
 * @param {object} [options]
 * @param {() => string} [options.random] Token factory (test seam)
 * @returns {Promise<string>} The persisted token
 */
export async function ensureToken(db, routeKey, options = {}) {
  const { random = defaultRandom } = options;
  const candidate = random();
  const siteConfig = db.collection("siteConfig");

  // Migrate a legacy homepage slot before generating, so we never overwrite
  // the live token with a fresh one.
  const existing = await siteConfig.findOne({ _id: SITE_CONFIG_ID });
  await maybeMigrateLegacyHomepage(siteConfig, routeKey, existing);

  try {
    await siteConfig.updateOne(
      { _id: SITE_CONFIG_ID },
      { $setOnInsert: { [tokenPath(routeKey)]: candidate } },
      { upsert: true },
    );
  } catch (error) {
    // E11000: a concurrent upsert inserted the doc first — fine, it exists.
    if (error?.code !== 11_000) throw error;
  }
  await siteConfig.updateOne(
    { _id: SITE_CONFIG_ID, [tokenPath(routeKey)]: { $exists: false } },
    { $set: { [tokenPath(routeKey)]: candidate } },
  );
  const doc = await siteConfig.findOne({ _id: SITE_CONFIG_ID });
  return doc.previews[routeKey].token;
}

/**
 * Atomically increment a surface's preview revision and return the NEW value
 * (findOneAndUpdate, not update-then-read — a racing bump can never make two
 * callers see the same number). Migrates a legacy homepage slot first so the
 * first homepage bump continues from the live revision, not from 0.
 *
 * @param {object} db
 * @param {string} routeKey
 * @returns {Promise<number>} The post-increment revision
 */
export async function bumpRevision(db, routeKey) {
  const siteConfig = db.collection("siteConfig");
  const existing = await siteConfig.findOne({ _id: SITE_CONFIG_ID });
  await maybeMigrateLegacyHomepage(siteConfig, routeKey, existing);

  const result = await siteConfig.findOneAndUpdate(
    { _id: SITE_CONFIG_ID },
    { $inc: { [revisionPath(routeKey)]: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  // Driver v4/v5 wraps the doc in { value }; v6 returns it directly.
  const doc = result?.value ?? result;
  return doc.previews[routeKey].revision;
}

/**
 * Unconditionally replace a surface's preview token (the publish path — every
 * publish expires previously shared preview URLs for that surface).
 *
 * @param {object} db
 * @param {string} routeKey
 * @param {object} [options]
 * @param {() => string} [options.random] Token factory (test seam)
 * @returns {Promise<string>} The new token
 */
export async function rotateToken(db, routeKey, options = {}) {
  const { random = defaultRandom } = options;
  const token = random();
  await db.collection("siteConfig").updateOne(
    { _id: SITE_CONFIG_ID },
    { $set: { [tokenPath(routeKey)]: token } },
    { upsert: true },
  );
  return token;
}
