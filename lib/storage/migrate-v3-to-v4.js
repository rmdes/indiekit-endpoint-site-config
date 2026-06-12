/**
 * v3 → v4 migration (spec §7), Phase 2 mode: DUAL-RUNNING and read-only
 * with respect to everything the live site consumes. The v3 homepageConfig
 * doc is never modified, renamed or deleted (the legacy admin UI and
 * writeHomepageJson still own it until the Phase 3 cutover); this module
 * computes v4 composition docs from it and (non-dry) seeds them into the
 * `compositions` collection IF ABSENT — never overwriting, so later editor
 * edits survive re-runs (idempotent by construction). The destructive
 * cutover steps (source-doc backup-rename, artifact switchover) are Phase 3.
 *
 * Verified v3 semantics encoded here: hero renders before the layout
 * wrapper in ALL layouts when `hero.enabled`; `sections[]` entries with
 * type "hero" are skipped by the v3 renderer (dropped here, with a report
 * warning); two-column and full-width-hero produce identical markup
 * (sidebar present → 2-1 columns); sidebar-less two-column and unknown
 * layouts degrade to the single-column shape; the current `.sidebar` is
 * sticky.
 *
 * Wildcard surfaces (resolves spec §7's `collection:*`):
 *   blogListingSidebar → _id "collection:default", kind "collection",
 *     target { collection: "default" }
 *   blogPostSidebar    → _id "posttype:default", kind "postType",
 *     target { postType: "default" }
 * Empty sidebar arrays produce NO doc. Phase 6's per-collection overrides
 * layer on top of "default". CV (page:cv) is deliberately NOT migrated
 * here — Phase 6.
 *
 * Ids (spec §11(4)): uniform b_ (sections) / c_ (containers) prefixes per
 * node KIND — no s_/w_ split. Containers get ids too (crash-containment
 * debuggability).
 *
 * GATE-NOT-TRANSFORMER: docs are persisted RAW; validateComposition is used
 * only to gate (its `value` materializes schema defaults — never persisted).
 * If ANY computed doc fails validation, non-dry mode writes NOTHING (no
 * partial seeds). Database errors propagate to the caller's try/catch.
 *
 * @module storage/migrate-v3-to-v4
 */
import { randomBytes } from "node:crypto";

import { validateComposition } from "../validators/composition.js";

const defaultIdFactory = (prefix) => `${prefix}_${randomBytes(3).toString("hex")}`;

/** @param {unknown} value @returns {object[]} */
const asArray = (value) => (Array.isArray(value) ? value : []);

const toSection = (entry, newId) => ({
  block: "section",
  id: newId("b"),
  type: entry.type,
  v: 0,
  config:
    entry.config && typeof entry.config === "object" && !Array.isArray(entry.config)
      ? { ...entry.config }
      : {},
});

const stack = (role, children, newId, variant) => ({
  block: "container",
  id: newId("c"),
  as: "stack",
  role,
  ...(variant ? { variant } : {}),
  children,
});

/**
 * Pure v3-homepage-doc → v4 tree mapping. Exported for direct unit testing.
 * Throw-free on plain-data input (hostile/partial v3 docs degrade to an
 * empty single-column shape rather than crashing).
 *
 * @param {object} v3 v3 homepageConfig document (untrusted plain data)
 * @param {(prefix: string) => string} [newId] Id factory (b/c prefixes)
 * @returns {object} v4 composition tree (root container)
 */
export function buildHomepageTree(v3, newId = defaultIdFactory) {
  const doc = v3 && typeof v3 === "object" && !Array.isArray(v3) ? v3 : {};
  const children = [];

  // Verified v3 semantic: hero renders BEFORE the layout wrapper in all
  // layouts. `enabled` is a placement concern, not config — dropped.
  if (doc.hero && typeof doc.hero === "object" && doc.hero.enabled) {
    const { enabled: _enabled, ...config } = doc.hero;
    children.push({ block: "section", id: newId("b"), type: "hero", v: 0, config });
  }

  // Verified v3 semantic: the renderer skips type "hero" entries in
  // sections[] (every branch) — the doc-level hero object is the real hero.
  const sections = asArray(doc.sections)
    .filter((entry) => entry?.type && entry.type !== "hero")
    .map((entry) => toSection(entry, newId));
  const sidebar = asArray(doc.sidebar)
    .filter((entry) => entry?.type)
    .map((entry) => toSection(entry, newId));

  // Verified v3 semantic: two-column and full-width-hero produce IDENTICAL
  // markup; sidebar-less and unknown layouts degrade to single-column.
  const hasSidebar =
    sidebar.length > 0 &&
    (doc.layout === "two-column" || doc.layout === "full-width-hero");

  if (hasSidebar) {
    children.push({
      block: "container",
      id: newId("c"),
      as: "columns",
      role: "region",
      variant: { width: "default", columns: "2-1", gap: "loose" },
      children: [
        stack("main", sections, newId),
        // Verified v3 semantic: the current .sidebar is sticky.
        stack("complementary", sidebar, newId, { sticky: true }),
      ],
    });
  } else {
    children.push(stack("main", sections, newId));
  }

  const footer = asArray(doc.footer)
    .filter((entry) => entry?.type)
    .map((entry) => toSection(entry, newId));
  if (footer.length > 0) children.push(stack("contentinfo", footer, newId));

  return { block: "container", id: newId("c"), as: "stack", role: "root", children };
}

/**
 * Build a sidebar-surface composition doc, or null when the source array is
 * empty (empty sidebar → NO doc).
 * @param {string} _id
 * @param {string} kind
 * @param {object} target
 * @param {unknown} entries v3 sidebar entry array
 * @param {(prefix: string) => string} newId
 * @returns {object | null}
 */
function sidebarComposition(_id, kind, target, entries, newId) {
  const blocks = asArray(entries)
    .filter((entry) => entry?.type)
    .map((entry) => toSection(entry, newId));
  if (blocks.length === 0) return null;
  return {
    _id,
    schemaVersion: 4,
    kind,
    target,
    status: "published",
    tree: stack("root", [stack("complementary", blocks, newId, { sticky: true })], newId),
  };
}

/**
 * Compute v4 composition docs from the v3 homepageConfig doc, validate them
 * against the block catalog (gate only — raw docs are what's persisted), and
 * in non-dry mode seed any that don't already exist.
 *
 * The ONLY interaction with the v3 source is a single read
 * (`homepageConfig.findOne`) — nothing here writes to, renames, or deletes
 * the v3 doc.
 *
 * @param {object} db MongoDB database handle (`collection(name)`)
 * @param {object[]} catalogEntries Block catalog (scanner output or BUILTIN_BLOCKS)
 * @param {object} [options]
 * @param {boolean} [options.dryRun] Compute + validate only, write nothing
 * @param {(prefix: string) => string} [options.idFactory] Node id factory
 * @param {() => string} [options.now] ISO timestamp factory
 * @param {string} [options.updatedBy] Stamp for seeded docs
 * @returns {Promise<{ docs: object[], report: object }>}
 */
export async function migrateV3toV4(db, catalogEntries, options = {}) {
  const {
    dryRun = false,
    idFactory = defaultIdFactory,
    now = () => new Date().toISOString(),
    updatedBy = "migrate-v3-to-v4",
  } = options;

  const source = await db.collection("homepageConfig").findOne({ _id: "homepage" });
  if (!source) {
    // Same shape as the normal-path report — consumers (Task 8's boot log /
    // admin endpoint) read report.seeded.length etc. unconditionally.
    return {
      docs: [],
      report: {
        skipped: true,
        reason: "no v3 homepageConfig doc",
        dryRun,
        valid: true,
        errors: [],
        warnings: [],
        seeded: [],
        skippedExisting: [],
      },
    };
  }

  const stamp = { updatedAt: now(), updatedBy };
  const docs = [
    {
      _id: "homepage",
      schemaVersion: 4,
      kind: "homepage",
      status: "published",
      tree: buildHomepageTree(source, idFactory),
    },
    sidebarComposition(
      "collection:default",
      "collection",
      { collection: "default" },
      source.blogListingSidebar,
      idFactory,
    ),
    sidebarComposition(
      "posttype:default",
      "postType",
      { postType: "default" },
      source.blogPostSidebar,
      idFactory,
    ),
  ]
    .filter(Boolean)
    .map((doc) => ({ ...doc, ...stamp }));

  const report = {
    skipped: false,
    dryRun,
    valid: true,
    errors: [],
    warnings: [],
    seeded: [],
    skippedExisting: [],
  };

  const droppedHeroEntries = asArray(source.sections).filter(
    (entry) => entry?.type === "hero",
  ).length;
  if (droppedHeroEntries > 0) {
    const noun = droppedHeroEntries === 1 ? "entry" : "entries";
    report.warnings.push(
      `homepage: dropped ${droppedHeroEntries} sections[] hero ${noun} ` +
        "(the v3 renderer skips them; the doc-level hero object is the real hero)",
    );
  }

  for (const doc of docs) {
    const result = validateComposition(doc, catalogEntries, { stripUnknown: true });
    report.warnings.push(...result.warnings.map((w) => `${doc._id}: ${w}`));
    if (!result.ok) {
      report.valid = false;
      report.errors.push(...result.errors.map((e) => `${doc._id}: ${e}`));
    }
  }
  // Any invalid doc → write NOTHING (no partial seeds); caller inspects report.
  if (dryRun || !report.valid) return { docs, report };

  // TOCTOU precondition: this check-then-write (findOne → replaceOne) is NOT
  // concurrency-safe — two racing callers could both observe "absent" and
  // both write. It is acceptable ONLY because the single caller is boot-time
  // init (Task 8), which runs once before any editor traffic. A concurrent
  // or admin-triggered caller must switch to an atomic upsert with
  // $setOnInsert, or insertOne + duplicate-key handling.
  const compositions = db.collection("compositions");
  for (const doc of docs) {
    const existing = await compositions.findOne({ _id: doc._id });
    if (existing) {
      report.skippedExisting.push(doc._id); // never clobber editor work
      continue;
    }
    await compositions.replaceOne({ _id: doc._id }, doc, { upsert: true });
    report.seeded.push(doc._id);
  }
  return { docs, report };
}
