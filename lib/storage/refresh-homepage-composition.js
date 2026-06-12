/**
 * Phase 3 bridge — the v3 homepage admin remains the ONLY editor until
 * Phase 4, so every v3 homepage save must propagate to the v4 composition
 * doc AND its on-disk artifact (the theme activation switch,
 * compositions/homepage.json). This module is that propagation: read the v3
 * doc, rebuild the v4 homepage composition via buildHomepageTree, gate it
 * with validateComposition, then REPLACE the stored composition (explicit
 * refresh — deliberately distinct from the migrator's seed-if-absent: v3 is
 * the editing source of truth until Phase 4) and write the artifact.
 *
 * **Phase 4 MUST remove the controller hook when the composition editor
 * becomes the source of truth**, else v3 saves clobber editor work.
 *
 * The doc is fully rebuilt with FRESH node ids on every refresh — any
 * id-keyed client state (e.g. the theme chrome's localStorage) resets on
 * each v3 save until Phase 4. Acceptable; also noted in the theme plan.
 *
 * Invalid trees write NOTHING (neither db nor artifact) — never replace a
 * good artifact with a bad one. Database and artifact-writer errors
 * propagate to the caller (the controller/boot wiring owns the try/catch).
 *
 * @module storage/refresh-homepage-composition
 */

import { buildHomepageTree } from "./migrate-v3-to-v4.js";
import { validateComposition } from "../validators/composition.js";
import { writeCompositionJson } from "../render/write-composition-json.js";

/**
 * Rebuild, validate, persist and publish the homepage composition from the
 * current v3 homepageConfig doc.
 *
 * @param {object} db MongoDB database handle (`collection(name)`)
 * @param {object[]} catalogEntries Block catalog (scanner output or BUILTIN_BLOCKS)
 * @param {object} [options]
 * @param {(doc: object) => Promise<unknown>} [options.writeArtifact] Artifact writer (defaults to writeCompositionJson)
 * @param {(prefix: string) => string} [options.idFactory] Node id factory (b/c prefixes)
 * @param {() => string} [options.now] ISO timestamp factory
 * @param {string} [options.updatedBy] Provenance stamp for the refreshed doc
 * @returns {Promise<{ ok: boolean, skipped: boolean, errors: string[], warnings: string[] }>}
 *   Uniform report shape; the no-v3-doc no-op adds `reason` (migrator convention).
 */
export async function refreshHomepageComposition(db, catalogEntries, options = {}) {
  const {
    writeArtifact = writeCompositionJson,
    idFactory,
    now = () => new Date().toISOString(),
    updatedBy = "refresh-homepage-composition",
  } = options;

  const source = await db.collection("homepageConfig").findOne({ _id: "homepage" });
  if (!source) {
    // Same shape as the normal-path report (plus reason) — callers read
    // report.errors etc. unconditionally, matching the migrator convention.
    return {
      ok: true,
      skipped: true,
      reason: "no v3 homepageConfig doc",
      errors: [],
      warnings: [],
    };
  }

  const doc = {
    _id: "homepage",
    schemaVersion: 4,
    kind: "homepage",
    status: "published",
    tree: buildHomepageTree(source, idFactory),
    updatedAt: now(),
    updatedBy,
  };

  // GATE-NOT-TRANSFORMER (migrator convention): validate to gate only; the
  // RAW doc is what's persisted — result.value's materialized defaults never
  // are. stripUnknown keeps hostile extra fields from failing a refresh.
  const result = validateComposition(doc, catalogEntries, { stripUnknown: true });
  if (!result.ok) {
    // Never replace a good composition/artifact with a bad one.
    return { ok: false, skipped: false, errors: result.errors, warnings: result.warnings };
  }

  // OVERWRITE on purpose: until Phase 4 the v3 admin is the source of truth,
  // so a refresh must win over whatever is stored (unlike the boot migrator,
  // which seeds-if-absent to protect future editor work).
  await db.collection("compositions").replaceOne({ _id: "homepage" }, doc, { upsert: true });
  await writeArtifact(doc);

  return { ok: true, skipped: false, errors: [], warnings: result.warnings };
}
