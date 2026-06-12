/**
 * Tolerant reader for the Eleventy build-status file (site-builder Phase 5,
 * spec §2.4/§5.3). The file lives OUTSIDE the site output at
 * `/app/data/build-status.json` — written by the theme's build hooks
 * (building/ok) and start.sh's crash wrapper (failed); read here by the
 * preview flow (S1: `lastOkDurationSeconds` → "~Xs on this site" copy) and
 * the authed build-status API (S2).
 *
 * TOLERANT BY CONTRACT: absent, unreadable, corrupt, or non-object content
 * all return null — the status file is an observability aid and must never
 * take a request down. Callers own the "unknown" presentation.
 *
 * @module storage/read-build-status
 */

import { readFile } from "node:fs/promises";

export const BUILD_STATUS_PATH = "/app/data/build-status.json";

/**
 * Read and parse the build-status file.
 *
 * @param {string} [path=BUILD_STATUS_PATH] File path (test seam)
 * @returns {Promise<object | null>} The parsed status object, or null when
 *   the file is absent/corrupt/not a plain object
 */
export async function readBuildStatus(path = BUILD_STATUS_PATH) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
