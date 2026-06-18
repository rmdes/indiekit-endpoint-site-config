/**
 * Preview-draft artifact writer (site-builder Phase 5, spec §2.4/§5.3;
 * per-surface since #32-T2).
 *
 * The theme's `/preview/<token>/` page renders this artifact through the
 * PRODUCTION composition renderer (zero drift from the live surface).
 * Written ON DEMAND only — the editor's explicit "Update preview" POST and
 * the post-publish refresh — NEVER per keystroke: every artifact write
 * triggers an incremental Eleventy rebuild (~25s on large sites).
 *
 * ONE file per surface: `<outputDir>/preview-<routeKey>.json` (e.g.
 * `preview-homepage.json`, `preview-listing.json`, `preview-posttype.json`),
 * with the routeKey also stamped into the artifact as `surface`. routeKeys
 * carry no colon (unlike composition surface ids), so the filename is simply
 * `preview-<surface>.json` — no colon→dash mapping needed.
 *
 * The artifact is BUILT from explicit arguments (never picked off a MongoDB
 * doc), so editor-internal fields can't leak by construction — the same
 * deliberate-contract posture as write-composition-json.js's whitelist.
 *
 * Uses tmp-file + rename so the Eleventy watcher never reads a partial file
 * (a direct writeFile races the watcher and can crash the build on
 * JSON.parse). Mirrors the atomic pattern in write-composition-json.js.
 *
 * The token is an unguessable-path token (defense in depth, rotated on
 * publish) — it ends up in this public-ish artifact and the preview URL by
 * design, but must never be logged.
 * @module render/write-preview-draft
 */

import { writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/**
 * Per-surface preview artifact file name. routeKeys ("homepage"/"listing"/
 * "posttype") have no colon, so this is a plain interpolation — no
 * filesystem-unfriendly characters to escape (cf. write-composition-json.js's
 * surfaceFileName, which maps colons to dashes for composition surface ids).
 *
 * @param {string} surface - Surface routeKey
 * @returns {string} Artifact file name (with `.json` extension)
 */
export const previewDraftFile = (surface) => `preview-${surface}.json`;

const isoNow = () => new Date().toISOString();

/**
 * Write the preview-draft artifact to disk atomically (tmp file → rename).
 * Creates the output directory if it does not exist.
 *
 * @param {object} input
 * @param {string} input.surface - Surface routeKey ("homepage"/"listing"/
 *   "posttype"); selects the per-surface filename and is stamped into the artifact
 * @param {object} input.tree - Composition tree to preview (draft or published)
 * @param {number} input.revision - Monotonic preview revision (preview-state.js)
 * @param {string} input.token - Unguessable preview path token (preview-state.js)
 * @param {string} [outputDir="/app/data/content/_data/compositions"] - Destination directory
 * @param {object} [options]
 * @param {() => string} [options.now] ISO timestamp factory (workspace rule:
 *   dates are ISO 8601 strings, never Date objects)
 * @returns {Promise<string>} The output path written
 */
export async function writePreviewDraft(
  { surface, tree, revision, token },
  outputDir = "/app/data/content/_data/compositions",
  options = {},
) {
  const { now = isoNow } = options;
  // Explicit construction — exactly the spec §2.4 shape, nothing else.
  const artifact = {
    schemaVersion: 4,
    kind: "preview",
    surface,
    tree,
    revision,
    token,
    generatedAt: now(),
  };

  const outputPath = join(outputDir, previewDraftFile(surface));
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
