/**
 * One-time forced re-seed of the listing surface (6.3-T7, design D7 option a).
 *
 * WHY THIS EXISTS — drift reconciliation at the 6.3 cutover:
 * The v3→v4 migrator (migrate-v3-to-v4.js) is SEED-IF-ABSENT — it never
 * overwrites an existing `collection:default` composition so editor edits
 * survive re-runs. But that very safety creates a drift problem: an operator
 * who edited the blog tab's `blogListingSidebar` AFTER the migrator first
 * seeded `collection:default` now has a STALE composition (the migrator won't
 * re-seed it). 6.3 dissolves the blog-tab listing sidebar into the listing
 * surface, so at cutover we must carry that operator's LATEST blog-tab edit
 * into `collection:default` ONCE — a DELIBERATE overwrite, unlike the
 * skip-if-exists migrator.
 *
 * RUN-ONCE GATE — the safety-critical contract:
 * After this runs, the listing surface is the source of truth and the operator
 * edits it in Design → Listing. This module MUST therefore run EXACTLY ONCE:
 * a second overwrite on a later boot would clobber the operator's
 * listing-editor edits. The gate is a boolean flag on the siteConfig singleton
 * (`_id: "primary"`) at `migrations.listingReseed`. Set true on the FIRST run
 * (whether or not anything was actually re-seeded), checked first on every
 * subsequent run → no-op. Idempotent by construction.
 *
 * OVERWRITE SEMANTICS:
 * - blogListingSidebar non-empty → REPLACE collection:default's published
 *   `tree` (built via the migrator's `sidebarComposition`), set status
 *   "published" + updatedAt. A forced re-seed at cutover replaces the published
 *   tree; any `draftTree` present is PRE-CUTOVER noise and is dropped (the new
 *   replaceOne writes a doc without a draftTree). Pre-cutover, no listing
 *   editor existed to create a meaningful draft.
 * - blogListingSidebar empty → NO overwrite (migrator parity: an empty sidebar
 *   yields no doc). The pre-existing doc, if any, is left untouched — we do not
 *   clobber to empty. The gate is still set so it never runs again.
 *
 * @module storage/reseed-listing
 */
import { randomBytes } from "node:crypto";

import { sidebarComposition } from "./migrate-v3-to-v4.js";

const defaultIdFactory = (prefix) => `${prefix}_${randomBytes(3).toString("hex")}`;

const LISTING_ID = "collection:default";

/**
 * Run the one-time forced re-seed. Safe to call on every boot — the run-once
 * gate makes all calls after the first a no-op.
 *
 * @param {object} db MongoDB database handle (`collection(name)`), or falsy
 * @param {object} [options]
 * @param {(prefix: string) => string} [options.idFactory] Node id factory (b/c prefixes)
 * @param {() => string} [options.now] ISO timestamp factory
 * @param {string} [options.updatedBy] Stamp for the re-seeded doc
 * @returns {Promise<{ ran: boolean, reseeded: boolean, reason?: string }>}
 *   `ran` — whether this invocation performed the one-time work (vs gated no-op);
 *   `reseeded` — whether collection:default's tree was actually overwritten.
 */
export async function reseedListingComposition(db, options = {}) {
  const {
    idFactory = defaultIdFactory,
    now = () => new Date().toISOString(),
    updatedBy = "reseed-listing",
  } = options;

  if (!db) return { ran: false, reseeded: false, reason: "no database" };

  const siteConfigs = db.collection("siteConfig");

  // GATE CHECK — first thing, before any read of the source or any write.
  const siteConfig = await siteConfigs.findOne({ _id: "primary" });
  if (siteConfig?.migrations?.listingReseed === true) {
    return { ran: false, reseeded: false, reason: "already run" };
  }

  // Read the operator's CURRENT blog-tab listing sidebar.
  const source = await db.collection("homepageConfig").findOne({ _id: "homepage" });
  const doc = sidebarComposition(
    LISTING_ID,
    "collection",
    { collection: "default" },
    source?.blogListingSidebar,
    idFactory,
  );

  let reseeded = false;
  if (doc) {
    // DELIBERATE overwrite (unlike the skip-if-exists migrator): replace the
    // published tree from the current blogListingSidebar. Any pre-cutover
    // draftTree is intentionally NOT carried over — replaceOne writes the doc
    // as built (no draftTree key).
    const stamped = { ...doc, updatedAt: now(), updatedBy };
    await db.collection("compositions").replaceOne(
      { _id: LISTING_ID },
      stamped,
      { upsert: true },
    );
    reseeded = true;
  }
  // else: empty blogListingSidebar (or no homepage doc) → migrator parity, no
  // doc; leave any existing collection:default untouched (do NOT clobber).

  // SET THE GATE — runs whether or not we re-seeded, so an empty sidebar still
  // pins the one-time semantics and a later non-empty blog-tab value can never
  // re-trigger an overwrite. Upsert: a fresh install may have no siteConfig doc
  // yet (seed-from-env runs separately).
  await siteConfigs.updateOne(
    { _id: "primary" },
    { $set: { "migrations.listingReseed": true } },
    { upsert: true },
  );

  return { ran: true, reseeded };
}
