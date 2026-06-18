/**
 * One-time forced re-seed of a sidebar surface (6.3-T7 / 6.4-T3, design D7/D6).
 *
 * Shared helper for BOTH sidebar surfaces:
 *   - collection:default  (listing) ← blogListingSidebar, gate migrations.listingReseed
 *   - posttype:default    (postType) ← blogPostSidebar,   gate migrations.posttypeReseed
 * Parameterized by a `surfaceSpec` so each surface gets the SAME mechanism with
 * its own source field and its OWN independent run-once gate.
 *
 * WHY THIS EXISTS — drift reconciliation at cutover:
 * The v3→v4 migrator (migrate-v3-to-v4.js) is SEED-IF-ABSENT — it never
 * overwrites an existing surface composition so editor edits survive re-runs.
 * But that very safety creates a drift problem: an operator who edited the blog
 * tab's sidebar (blogListingSidebar / blogPostSidebar) AFTER the migrator first
 * seeded the surface now has a STALE composition (the migrator won't re-seed
 * it). 6.3/6.4 dissolves the blog-tab sidebars into the listing/postType
 * surfaces, so at cutover we must carry that operator's LATEST blog-tab edit
 * into the surface ONCE — a DELIBERATE overwrite, unlike the skip-if-exists
 * migrator.
 *
 * RUN-ONCE GATE — the safety-critical contract:
 * After this runs, the surface is the source of truth and the operator edits it
 * in Design → Listing / Design → Post. This MUST therefore run EXACTLY ONCE per
 * surface: a second overwrite on a later boot would clobber the operator's
 * editor edits. The gate is a boolean flag on the siteConfig singleton
 * (`_id: "primary"`) at `migrations.<gateField>`. Set true on the FIRST run
 * (whether or not anything was actually re-seeded), checked first on every
 * subsequent run → no-op. Idempotent by construction. Each surface's gate is
 * INDEPENDENT — re-seeding one surface never sets or consumes another's gate.
 *
 * OVERWRITE SEMANTICS:
 * - source non-empty → REPLACE the surface's published `tree` (built via the
 *   migrator's `sidebarComposition`), set status "published" + updatedAt. A
 *   forced re-seed at cutover replaces the published tree; any `draftTree`
 *   present is PRE-CUTOVER noise and is dropped (the new replaceOne writes a
 *   doc without a draftTree). Pre-cutover, no surface editor existed to create
 *   a meaningful draft.
 * - source empty → NO overwrite (migrator parity: an empty sidebar yields no
 *   doc). The pre-existing doc, if any, is left untouched — we do not clobber
 *   to empty. The gate is still set so it never runs again.
 *
 * @module storage/reseed-sidebar-surface
 */
import { randomBytes } from "node:crypto";

import { sidebarComposition } from "./migrate-v3-to-v4.js";

const defaultIdFactory = (prefix) => `${prefix}_${randomBytes(3).toString("hex")}`;

/**
 * @typedef {object} SurfaceSpec
 * @property {string} surfaceId    Composition `_id` (e.g. "collection:default")
 * @property {string} kind         Composition kind ("collection" | "postType")
 * @property {object} target       Composition target (e.g. `{ collection: "default" }`)
 * @property {string} sourceField  homepageConfig field to read (e.g. "blogListingSidebar")
 * @property {string} gateField    siteConfig.migrations field for the run-once gate
 */

/**
 * Run the one-time forced re-seed for ONE sidebar surface. Safe to call on
 * every boot — the run-once gate makes all calls after the first a no-op. Each
 * surface's gate is independent of every other surface's gate.
 *
 * @param {object} db MongoDB database handle (`collection(name)`), or falsy
 * @param {SurfaceSpec} surfaceSpec Surface to re-seed
 * @param {object} [options]
 * @param {(prefix: string) => string} [options.idFactory] Node id factory (b/c prefixes)
 * @param {() => string} [options.now] ISO timestamp factory
 * @param {string} [options.updatedBy] Stamp for the re-seeded doc
 * @returns {Promise<{ ran: boolean, reseeded: boolean, reason?: string }>}
 *   `ran` — whether this invocation performed the one-time work (vs gated no-op);
 *   `reseeded` — whether the surface's tree was actually overwritten.
 */
export async function reseedSidebarSurface(db, surfaceSpec, options = {}) {
  const { surfaceId, kind, target, sourceField, gateField } = surfaceSpec;
  const {
    idFactory = defaultIdFactory,
    now = () => new Date().toISOString(),
    updatedBy = `reseed-${kind}`,
  } = options;

  if (!db) return { ran: false, reseeded: false, reason: "no database" };

  const siteConfigs = db.collection("siteConfig");
  const gatePath = `migrations.${gateField}`;

  // GATE CHECK — first thing, before any read of the source or any write. The
  // gate is THIS surface's gate only (independent of other surfaces' gates).
  const siteConfig = await siteConfigs.findOne({ _id: "primary" });
  if (siteConfig?.migrations?.[gateField] === true) {
    return { ran: false, reseeded: false, reason: "already run" };
  }

  // Read the operator's CURRENT blog-tab sidebar for this surface.
  const source = await db.collection("homepageConfig").findOne({ _id: "homepage" });
  const doc = sidebarComposition(
    surfaceId,
    kind,
    target,
    source?.[sourceField],
    idFactory,
  );

  let reseeded = false;
  if (doc) {
    // DELIBERATE overwrite (unlike the skip-if-exists migrator): replace the
    // published tree from the current blog-tab sidebar. Any pre-cutover
    // draftTree is intentionally NOT carried over — replaceOne writes the doc
    // as built (no draftTree key).
    const stamped = { ...doc, updatedAt: now(), updatedBy };
    await db.collection("compositions").replaceOne(
      { _id: surfaceId },
      stamped,
      { upsert: true },
    );
    reseeded = true;
  }
  // else: empty source (or no homepage doc) → migrator parity, no doc; leave
  // any existing surface doc untouched (do NOT clobber).

  // SET THE GATE — runs whether or not we re-seeded, so an empty sidebar still
  // pins the one-time semantics and a later non-empty blog-tab value can never
  // re-trigger an overwrite. Upsert: a fresh install may have no siteConfig doc
  // yet (seed-from-env runs separately).
  await siteConfigs.updateOne(
    { _id: "primary" },
    { $set: { [gatePath]: true } },
    { upsert: true },
  );

  return { ran: true, reseeded };
}

/**
 * Back-compat wrapper for the 6.3 listing re-seed. Keeps the original call site
 * and tests working unchanged — delegates to the generalized helper with the
 * collection:default / blogListingSidebar / listingReseed spec.
 *
 * @param {object} db MongoDB database handle, or falsy
 * @param {object} [options] See {@link reseedSidebarSurface}
 * @returns {Promise<{ ran: boolean, reseeded: boolean, reason?: string }>}
 */
export async function reseedListingComposition(db, options = {}) {
  return reseedSidebarSurface(
    db,
    {
      surfaceId: "collection:default",
      kind: "collection",
      target: { collection: "default" },
      sourceField: "blogListingSidebar",
      gateField: "listingReseed",
    },
    { updatedBy: "reseed-listing", ...options },
  );
}
