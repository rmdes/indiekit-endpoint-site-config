/**
 * Composition artifact JSON writer (spec §2.4) — THE theme activation switch.
 *
 * The theme's Tier-0 renders the homepage from the v4 composition path when
 * `compositions/homepage.json` exists on disk — writing that file IS the
 * Phase 3 cutover. Nothing in this module decides WHEN to write; only Task
 * S2's boot/save wiring calls it. One file per surface:
 * `<outputDir>/<surfaceFileName(doc._id)>.json`
 * Default dir: /app/data/content/_data/compositions
 *
 * Uses an explicit field whitelist so MongoDB/editor-internal fields
 * (`_id`, `updatedBy`, `draftTree`, `draftUpdatedAt`, future bookkeeping)
 * never leak into the public artifact (spec §2.4: never serialize
 * internals) — the same deliberate-contract pattern as
 * write-block-catalog-json.js. Adding a new public field requires an
 * explicit edit here.
 *
 * Uses tmp-file + rename so the Eleventy watcher never reads a partial file
 * (a direct writeFile races the watcher and can crash the build on
 * JSON.parse). Mirrors the atomic pattern in write-block-catalog-json.js.
 * @module render/write-composition-json
 */

import { writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

// Whitelisted public fields (spec §2.4: published state only — drafts and
// provenance stay in MongoDB).
const PUBLIC_FIELDS = ["schemaVersion", "kind", "target", "status", "tree", "updatedAt"];

/**
 * Map a composition surface id to its artifact file name (spec §2.4 naming).
 * Colons are not filesystem/URL-friendly, so they become dashes:
 * `homepage` → `homepage`, `collection:default` → `collection-default`,
 * `posttype:default` → `posttype-default`.
 *
 * @param {string} id - Composition surface id (the MongoDB `_id`)
 * @returns {string} File name without the `.json` extension
 */
export function surfaceFileName(id) {
  return String(id).replace(/:/g, "-");
}

/**
 * Write one composition document's public artifact to disk atomically
 * (tmp file → rename). Creates the output directory if it does not exist.
 *
 * Only the whitelisted PUBLIC_FIELDS are serialized, picked with
 * Object.hasOwn (not `in`) so inherited/poisoned prototype properties never
 * leak into the artifact.
 *
 * The tmp file uses a random suffix so concurrent callers don't collide on a
 * shared tmp name. The rename itself is atomic on POSIX — Eleventy's file
 * watcher will not observe a partial write. On failure the tmp file is
 * unlinked (best-effort) and the error rethrown.
 *
 * @param {object} doc - v4 composition document (must carry `_id`)
 * @param {string} [outputDir="/app/data/content/_data/compositions"] - Destination directory
 * @returns {Promise<string>} The output path written
 */
export async function writeCompositionJson(
  doc,
  outputDir = "/app/data/content/_data/compositions",
) {
  const artifact = {};
  for (const field of PUBLIC_FIELDS) {
    // Object.hasOwn, not `in`: `in` walks the prototype chain, which would
    // let inherited/poisoned properties leak into the artifact.
    if (Object.hasOwn(doc, field)) artifact[field] = doc[field];
  }

  const outputPath = join(outputDir, `${surfaceFileName(doc._id)}.json`);
  await mkdir(outputDir, { recursive: true });
  const tmp = `${outputPath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(artifact, undefined, 2), "utf8");
    await rename(tmp, outputPath);
  } catch (error) {
    // Best-effort cleanup — don't leak tmp files into the watched _data dir.
    await unlink(tmp).catch(() => {});
    throw error;
  }
  return outputPath;
}

/**
 * Resolve the LIVE surface artifact ids (the surfaces whose composition the
 * theme reads from disk today). Derived from the surface registry so 6.4/6.5
 * auto-extend: a surface goes live by being added to `SURFACES`, and its
 * artifact is then written here with no edit to this loop.
 *
 * The registry is imported lazily (inside the function) rather than at module
 * top so `write-composition-json.js` — imported in many places, including the
 * pure-data write paths — keeps a light static dependency graph and never
 * pulls in the editor/zone-model graph just to write one file.
 *
 * @returns {Promise<string[]>} Ordered live surface ids (e.g. ["homepage", "collection:default"])
 */
async function liveSurfaceIds() {
  const { SURFACES } = await import("../editor/surface-registry.js");
  return Object.values(SURFACES).map((surface) => surface.surfaceId);
}

/**
 * Boot artifact-write loop (spec D3 / §3): write ONE composition artifact per
 * LIVE surface id. Self-heals every artifact on every start. Each surface is
 * independent — a per-doc `doc?.tree` guard skips draft-only surfaces (an
 * apply-recipe fresh install can insert a draft-only doc with no published
 * tree; writing that would activate the theme's v4 path with an empty
 * artifact). Surfaces not yet in the registry (e.g. posttype:default until
 * 6.4) are never visited.
 *
 * @param {object} db MongoDB database handle (`collection(name)`)
 * @param {object} [options]
 * @param {string[]} [options.surfaceIds] Override the live id list (defaults to the registry's live set)
 * @param {string} [options.outputDir] Destination directory for artifacts
 * @param {(doc: object, outputDir?: string) => Promise<string>} [options.writer] Single-artifact writer (injectable for tests)
 * @param {(surfaceId: string) => void} [options.onWrite] Called after each surface is written (logging hook)
 * @returns {Promise<string[]>} The surface ids actually written (published-tree docs only)
 */
export async function writeCompositionArtifacts(db, options = {}) {
  const {
    surfaceIds = await liveSurfaceIds(),
    outputDir,
    writer = writeCompositionJson,
    onWrite,
  } = options;

  const written = [];
  for (const surfaceId of surfaceIds) {
    const doc = await db.collection("compositions").findOne({ _id: surfaceId });
    // Per-doc tree guard (preserved from the original single-surface write):
    // a draft-only doc has no published `tree` and must NOT be written.
    if (!doc?.tree) continue;
    await writer(doc, outputDir);
    written.push(surfaceId);
    onWrite?.(surfaceId);
  }
  return written;
}
