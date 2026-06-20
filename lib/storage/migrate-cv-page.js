/**
 * Phase 7 Task 3 — seed a `page:cv` composition from the retired CV plugin's
 * `cvPageConfig` layout (one-time, seed-if-absent).
 *
 * The CV plugin (>=1.1.0) no longer ships a bespoke page-builder; `/cv` renders
 * via a site-config `page:cv` standalone composition. This migration carries the
 * operator's EXISTING CV layout into the composition system so nothing is lost.
 *
 * Two reuses keep it low-risk:
 * - **Transform** = `buildHomepageTree` (migrate-v3-to-v4): `cvPageConfig` has the
 *   same `{layout, hero, sections, sidebar, footer}` shape as a v3 homepage doc,
 *   and that builder is already tested to emit validation-passing v4 trees.
 * - **Seed** = `createPage` (composition-draft): `$setOnInsert`-only (seed-if-
 *   absent, never clobbers an existing page:cv) and DRAFT-only (`draftTree`, no
 *   published `tree`) — so a seeded page:cv does NOT emit `/cv/` until explicitly
 *   published, which is the /cv-collision guard for the atomic cutover (Task 4).
 *
 * @module storage/migrate-cv-page
 */

import { buildHomepageTree } from "./migrate-v3-to-v4.js";
import { createPage } from "./composition-draft.js";

/**
 * The layout the retired CV page-builder defaulted to (former
 * `lib/storage/cvPageConfig.js` getDefaultConfig) — used when no `cvPageConfig`
 * doc exists to migrate.
 */
export const DEFAULT_CV_PAGE_CONFIG = {
  layout: "single-column",
  hero: { enabled: true, showSocial: true },
  sections: [
    { type: "cv-experience-work", config: {} },
    { type: "cv-skills-work", config: {} },
    { type: "cv-projects-work", config: {} },
    { type: "cv-education-work", config: {} },
    { type: "cv-languages", config: {} },
    { type: "cv-interests-work", config: {} },
  ],
  sidebar: [],
  footer: [],
};

/**
 * Pure transform: a `cvPageConfig` layout → a v4 composition tree. Falls back to
 * {@link DEFAULT_CV_PAGE_CONFIG} when given a non-object (absent doc). Throw-free
 * (delegates to the hardened `buildHomepageTree`).
 * @param {object|null} cvPageConfig
 * @param {(prefix: string) => string} [newId] - id factory (tests)
 * @returns {object} v4 tree (root container)
 */
export function cvPageConfigToTree(cvPageConfig, newId) {
  const source =
    cvPageConfig && typeof cvPageConfig === "object" && !Array.isArray(cvPageConfig)
      ? cvPageConfig
      : DEFAULT_CV_PAGE_CONFIG;
  return buildHomepageTree(source, newId);
}

/**
 * Seed `page:cv` if absent. Reads the legacy `cvPageConfig` Mongo doc (left in
 * place by the CV plugin's Task-2 removal), transforms it, and creates a DRAFT
 * page:cv. Idempotent via `createPage`'s create-only semantics. Never throws on
 * its own; the boot caller still wraps it.
 * @param {object|null} db - Indiekit.database
 * @param {object} [options]
 * @param {boolean} [options.dryRun] - transform only, no write
 * @param {() => string} [options.now] - ISO timestamp factory (passed to createPage)
 * @param {(prefix: string) => string} [options.newId] - id factory (tests)
 * @returns {Promise<object>} result summary
 */
export async function migrateCvPage(db, options = {}) {
  const { dryRun = false, now, newId } = options;
  if (!db) return { ok: false, reason: "no-db" };

  let source = null;
  try {
    source = await db.collection("cvPageConfig").findOne({ _id: "cv-page" });
  } catch {
    source = null;
  }
  const usedDefault = !source;
  const tree = cvPageConfigToTree(source, newId);

  if (dryRun) return { ok: true, dryRun: true, seeded: false, usedDefault, tree };

  const result = await createPage(
    db,
    "cv",
    { route: "/cv/", title: "CV" },
    tree,
    now ? { now } : {},
  );
  return {
    ok: true,
    seeded: result.ok === true,
    existed: result.ok === false,
    usedDefault,
  };
}
