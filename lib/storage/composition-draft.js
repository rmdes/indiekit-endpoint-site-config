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
 * @returns {Promise<{ ok: true } | { ok: false, error: "not-found" } | { ok: false, errors: string[] }>}
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
  await compositions.updateOne(
    { _id: surfaceId },
    {
      $set: { tree: candidate, updatedAt, updatedBy, status: "published" },
      $unset: { draftTree: "", draftUpdatedAt: "" },
    },
  );

  // Mirror the stored doc for the artifact: promoted tree + stamps, draft
  // fields stripped (writeCompositionJson whitelists anyway — this keeps
  // injected writers honest too). Errors propagate (caller catches).
  const { draftTree: _draftTree, draftUpdatedAt: _draftUpdatedAt, ...published } = doc;
  await writeArtifact({ ...published, tree: candidate, updatedAt, updatedBy, status: "published" });

  return { ok: true };
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
