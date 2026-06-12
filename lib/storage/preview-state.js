/**
 * Preview token + revision lifecycle (site-builder Phase 5, spec §5.3) —
 * stored as sibling fields on the siteConfig doc (`previewToken`,
 * `previewRevision`), the same same-doc posture as composition-draft.js.
 *
 * THE TOKEN: 16 random bytes, base64url (≈22 chars) — an unguessable-path
 * token for `/preview/<token>/`, ephemeral defense-in-depth. It is NEVER an
 * IndieAuth token and must never be logged. Rotated unconditionally on every
 * publish so previously shared preview URLs expire (the old URL dies on the
 * next rebuild — intentional, per-publish rotation policy).
 *
 * THE REVISION: a monotonic integer bumped on every preview-draft write. The
 * theme's preview page embeds it (`data-preview-revision`); the editor polls
 * the iframe until the just-written revision shows up.
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

const defaultRandom = () => randomBytes(16).toString("base64url");

/**
 * Read the current preview state from the siteConfig doc.
 *
 * @param {object} db MongoDB database handle (`collection(name)`)
 * @returns {Promise<{ token: string | null, revision: number }>}
 */
export async function getPreviewState(db) {
  const doc = await db.collection("siteConfig").findOne({ _id: SITE_CONFIG_ID });
  return {
    token: doc?.previewToken ?? null,
    revision: doc?.previewRevision ?? 0,
  };
}

/**
 * Return the persisted preview token, generating one atomically when absent.
 *
 * Two atomic field-level writes + a read-back: (1) $setOnInsert via upsert
 * covers the no-doc case (a concurrent upsert race surfaces as a duplicate
 * _id error — swallowed, the doc now exists either way); (2) a
 * $exists-filtered $set covers a pre-existing doc that lacks the field
 * (exactly one concurrent caller matches). The read-back is authoritative,
 * so every concurrent caller returns the SAME persisted token — never two.
 *
 * @param {object} db
 * @param {object} [options]
 * @param {() => string} [options.random] Token factory (test seam)
 * @returns {Promise<string>} The persisted token
 */
export async function ensureToken(db, options = {}) {
  const { random = defaultRandom } = options;
  const candidate = random();
  const siteConfig = db.collection("siteConfig");
  try {
    await siteConfig.updateOne(
      { _id: SITE_CONFIG_ID },
      { $setOnInsert: { previewToken: candidate } },
      { upsert: true },
    );
  } catch (error) {
    // E11000: a concurrent upsert inserted the doc first — fine, it exists.
    if (error?.code !== 11_000) throw error;
  }
  await siteConfig.updateOne(
    { _id: SITE_CONFIG_ID, previewToken: { $exists: false } },
    { $set: { previewToken: candidate } },
  );
  const doc = await siteConfig.findOne({ _id: SITE_CONFIG_ID });
  return doc.previewToken;
}

/**
 * Atomically increment the preview revision and return the NEW value
 * (findOneAndUpdate, not update-then-read — a racing bump can never make two
 * callers see the same number).
 *
 * @param {object} db
 * @returns {Promise<number>} The post-increment revision
 */
export async function bumpRevision(db) {
  const result = await db.collection("siteConfig").findOneAndUpdate(
    { _id: SITE_CONFIG_ID },
    { $inc: { previewRevision: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  // Driver v4/v5 wraps the doc in { value }; v6 returns it directly.
  const doc = result?.value ?? result;
  return doc.previewRevision;
}

/**
 * Unconditionally replace the preview token (the publish path — every
 * publish expires previously shared preview URLs).
 *
 * @param {object} db
 * @param {object} [options]
 * @param {() => string} [options.random] Token factory (test seam)
 * @returns {Promise<string>} The new token
 */
export async function rotateToken(db, options = {}) {
  const { random = defaultRandom } = options;
  const token = random();
  await db.collection("siteConfig").updateOne(
    { _id: SITE_CONFIG_ID },
    { $set: { previewToken: token } },
    { upsert: true },
  );
  return token;
}
