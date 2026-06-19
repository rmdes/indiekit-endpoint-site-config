/**
 * Composition draft storage — the Phase 4 editor's save/publish/discard
 * lifecycle over the `compositions` collection. Drafts live as sibling
 * fields ON the composition doc (`draftTree`, `draftUpdatedAt`); the
 * published `tree` is only ever touched by an explicit publish.
 *
 * ATOMICITY: every write here is a field-level `updateOne` ($set/$unset) —
 * NEVER a whole-doc replace. The migrator's TOCTOU note
 * (migrate-v3-to-v4.js) only tolerated check-then-replace because its sole
 * caller is single-threaded boot; the editor is concurrent admin traffic,
 * so a findOne→replaceOne here could resurrect deleted fields or clobber a
 * racing publish.
 *
 * PUBLISH GATE IS STRICT: `validateComposition(…, {})` without stripUnknown.
 * Editor-produced trees must be fully valid — unlike the migrator's
 * legacy-config leniency, there is no legacy excuse for unknown keys here.
 * Invalid candidates write NOTHING (neither db nor artifact).
 *
 * Artifact errors propagate to the caller AFTER the db promotion (Phase 3
 * posture: boot rewrites artifacts from MongoDB, so a db-ahead-of-disk
 * state self-heals on the next restart; the caller owns the try/catch).
 *
 * @module storage/composition-draft
 */

import { validateComposition } from "../validators/composition.js";
import { writeCompositionJson } from "../render/write-composition-json.js";

const isoNow = () => new Date().toISOString();

/**
 * Load a surface's editor state: the doc plus whichever tree the editor
 * should show (draft when one exists, else the published tree).
 *
 * @param {object} db MongoDB database handle (`collection(name)`)
 * @param {string} surfaceId Composition `_id` (e.g. "homepage")
 * @returns {Promise<{ doc: object, tree: object, isDraft: boolean } | null>}
 */
export async function getEditorState(db, surfaceId) {
  const doc = await db.collection("compositions").findOne({ _id: surfaceId });
  if (!doc) return null;
  return { doc, tree: doc.draftTree ?? doc.tree, isDraft: Boolean(doc.draftTree) };
}

/**
 * Store a draft tree on an existing composition doc (atomic $set; the
 * published tree and provenance stamps are untouched). Drafts are NOT
 * validated — the editor saves work-in-progress; the gate is publish.
 *
 * @param {object} db
 * @param {string} surfaceId
 * @param {object} tree Draft composition tree
 * @param {object} [options]
 * @param {() => string} [options.now] ISO timestamp factory
 * @returns {Promise<{ ok: true } | { ok: false, error: "not-found" }>}
 */
export async function saveDraft(db, surfaceId, tree, options = {}) {
  const { now = isoNow } = options;
  const result = await db.collection("compositions").updateOne(
    { _id: surfaceId },
    { $set: { draftTree: tree, draftUpdatedAt: now() } },
  );
  // Real driver result shape: matchedCount 0 ⇒ no such doc. Drafts never
  // create docs — the surface must have been seeded (migrator/editor).
  if (result.matchedCount === 0) return { ok: false, error: "not-found" };
  return { ok: true };
}

/**
 * Promote the draft (or republish the stored tree when no draft exists):
 * STRICT validation gate, then atomic promote + draft cleanup, then the
 * public artifact write.
 *
 * @param {object} db
 * @param {string} surfaceId
 * @param {object[]} catalogEntries Block catalog (scanner output or BUILTIN_BLOCKS)
 * @param {object} [options]
 * @param {(doc: object) => Promise<unknown>} [options.writeArtifact] Artifact
 *   writer (defaults to writeCompositionJson)
 * @param {() => string} [options.now] ISO timestamp factory
 * @param {string} [options.updatedBy] Provenance stamp
 * @returns {Promise<{ ok: true } | { ok: false, error: "not-found" | "conflict" } | { ok: false, errors: string[] }>}
 *   "conflict": a newer draft landed between read and promote — re-review
 *   and publish again (nothing was written).
 */
export async function publishDraft(db, surfaceId, catalogEntries, options = {}) {
  const {
    writeArtifact = writeCompositionJson,
    now = isoNow,
    updatedBy = "design-editor",
  } = options;

  const compositions = db.collection("compositions");
  const doc = await compositions.findOne({ _id: surfaceId });
  if (!doc) return { ok: false, error: "not-found" };

  const candidate = doc.draftTree ?? doc.tree;
  // GATE-NOT-TRANSFORMER (module-wide convention): validate to gate only,
  // the RAW candidate is what's persisted. STRICT — no stripUnknown.
  const result = validateComposition({ ...doc, tree: candidate }, catalogEntries, {});
  if (!result.ok) return { ok: false, errors: result.errors };

  const updatedAt = now();
  // Concurrency guard: promote only if the draft we validated is still the
  // stored draft. A saveDraft racing into the read→promote window changes
  // draftUpdatedAt, the filter misses, and we report a conflict instead of
  // publishing a tree nobody reviewed (or clobbering the newer draft).
  const promote = await compositions.updateOne(
    { _id: surfaceId, draftUpdatedAt: doc.draftUpdatedAt ?? { $exists: false } },
    {
      $set: { tree: candidate, updatedAt, updatedBy, status: "published" },
      $unset: { draftTree: "", draftUpdatedAt: "" },
    },
  );
  if (promote.matchedCount === 0) return { ok: false, error: "conflict" };

  // Mirror the stored doc for the artifact: promoted tree + stamps, draft
  // fields stripped (writeCompositionJson whitelists anyway — this keeps
  // injected writers honest too). Errors propagate (caller catches).
  const { draftTree: _draftTree, draftUpdatedAt: _draftUpdatedAt, ...published } = doc;
  await writeArtifact({ ...published, tree: candidate, updatedAt, updatedBy, status: "published" });

  return { ok: true };
}

/**
 * Create a composition doc WITH a draft when none exists (atomic upsert) —
 * the apply-recipe path on a fresh install (no v3 source, empty
 * `compositions`). saveDraft deliberately cannot create; this is the ONLY
 * draft entry point with upsert semantics, and its sole sanctioned caller
 * is the design controller's apply-recipe action.
 *
 * The inserted doc is DRAFT-ONLY: no published `tree` until the first
 * publishDraft promotes it (status "draft" until then). Consumers of
 * published state (artifact writers) must skip tree-less docs. On an
 * existing doc the $setOnInsert fields are inert — only the draft fields
 * change (recipe-over-existing behaves exactly like saveDraft).
 *
 * @param {object} db
 * @param {string} surfaceId
 * @param {string} kind Composition kind ("homepage" | "collection" | …)
 * @param {object} tree Draft composition tree
 * @param {object} [options]
 * @param {() => string} [options.now] ISO timestamp factory
 * @returns {Promise<{ ok: true }>}
 */
export async function createDraftFromTree(db, surfaceId, kind, tree, options = {}) {
  const { now = isoNow } = options;
  await db.collection("compositions").updateOne(
    { _id: surfaceId },
    {
      $set: { draftTree: tree, draftUpdatedAt: now() },
      $setOnInsert: { schemaVersion: 4, kind, status: "draft" },
    },
    { upsert: true },
  );
  return { ok: true };
}

/**
 * Atomic CREATE-ONLY for a standalone page (`page:<slug>`). Unlike
 * createDraftFromTree (whose `$set`-bearing upsert SILENTLY UPDATES an
 * existing doc's draft), this inserts a brand-new page doc IF AND ONLY IF one
 * doesn't already exist — it NEVER overwrites an existing page's draft, tree,
 * or target.
 *
 * Atomicity: a `$setOnInsert`-ONLY upsert (no `$set`). On a fresh `_id` the
 * driver inserts (`upsertedCount === 1`); on an existing `_id` the filter
 * matches, `$setOnInsert` is inert, and NOTHING is written — we report
 * `{ok:false, error:"exists"}`. The `_id` uniqueness on `page:<slug>` is the
 * create-race backstop: two concurrent creates → exactly one insert wins, the
 * loser sees a match (no overwrite). A real driver would also reject a true
 * concurrent insert with E11000; the create route maps both to a conflict.
 *
 * The inserted doc is DRAFT-ONLY (no published `tree`) — first publish
 * promotes it. `target` ({route,title}) IS set on insert (a page needs its
 * route/title at creation; that is the createDraftFromTree gap, D6).
 *
 * @param {object} db
 * @param {string} slug Validated page slug (caller ran guardPageRoute)
 * @param {{ route: string, title: string }} target Page route + title
 * @param {object} tree Starter draft composition tree
 * @param {object} [options]
 * @param {() => string} [options.now] ISO timestamp factory
 * @returns {Promise<{ ok: true } | { ok: false, error: "exists" }>}
 */
export async function createPage(db, slug, target, tree, options = {}) {
  const { now = isoNow } = options;
  const result = await db.collection("compositions").updateOne(
    { _id: `page:${slug}` },
    {
      // $setOnInsert ONLY — no $set. A matched (existing) doc is NOT modified.
      $setOnInsert: {
        schemaVersion: 4,
        kind: "page",
        status: "draft",
        target,
        draftTree: tree,
        draftUpdatedAt: now(),
      },
    },
    { upsert: true },
  );
  // upsertedCount 1 ⇒ a fresh insert. Anything else ⇒ the page already existed
  // (matched the filter) — refuse rather than overwrite.
  if (result.upsertedCount === 1) return { ok: true };
  return { ok: false, error: "exists" };
}

/**
 * List all standalone-page compositions (published + draft) as summaries for
 * the hub's pages card (T5 consumer). Derives the slug from the `page:<slug>`
 * `_id`. `hasDraft` reflects an unpublished edit in progress.
 *
 * @param {object} db
 * @returns {Promise<Array<{ slug: string, route: string, title: string,
 *   hasDraft: boolean, status: string, updatedAt: string | null }>>}
 */
export async function listPages(db) {
  const docs = await db.collection("compositions").find({ kind: "page" }).toArray();
  return docs.map((doc) => ({
    slug: typeof doc._id === "string" ? doc._id.replace(/^page:/, "") : doc._id,
    route: doc.target?.route ?? null,
    title: doc.target?.title ?? null,
    hasDraft: Boolean(doc.draftTree),
    status: doc.status ?? "draft",
    updatedAt: doc.updatedAt ?? null,
  }));
}

/**
 * Delete a composition doc entirely (delete/unpublish a page — it leaves the
 * published set). Graceful: deleting a non-existent doc is a successful no-op
 * (`deleted:false`).
 *
 * SEAM (T4): the `pages.json` artifact REWRITE on delete is the array writer's
 * job (writePagesJson). T3 only removes the doc; the delete route leaves a
 * documented call-point for T4 to wire the rewrite. NO `.md` is generated.
 *
 * @param {object} db
 * @param {string} surfaceId Composition `_id` (e.g. "page:about")
 * @returns {Promise<{ ok: true, deleted: boolean }>}
 */
export async function deleteComposition(db, surfaceId) {
  const result = await db.collection("compositions").deleteOne({ _id: surfaceId });
  return { ok: true, deleted: (result?.deletedCount ?? 0) > 0 };
}

/**
 * Drop the draft fields (atomic $unset). Idempotent: discarding when no
 * draft (or even no doc) exists is a successful no-op.
 *
 * @param {object} db
 * @param {string} surfaceId
 * @returns {Promise<{ ok: true }>}
 */
export async function discardDraft(db, surfaceId) {
  await db.collection("compositions").updateOne(
    { _id: surfaceId },
    { $unset: { draftTree: "", draftUpdatedAt: "" } },
  );
  return { ok: true };
}
