/**
 * Publication category list wiring (Category Governance, Layer 1 — wiring).
 *
 * Sets `Indiekit.publication.categories` to the canonical category names from
 * the content `.md` census — the same source the Categories tab counts from.
 * This is what activates Layer 1's normalise-on-write (jf2.js `getCategoryProperty`
 * folds authored categories to existing casing) and the `?q=category` typeahead.
 *
 * `Indiekit.publication` is a live object; the host's per-request `locals`
 * middleware re-assigns `app.locals.publication = Indiekit.publication`, so a
 * mutation here is seen by the very next Micropub write (no restart needed).
 *
 * @module storage/publication-categories
 */

import { censusFromContentDir } from "./category-census.js";

/**
 * Extract the canonical (preferred-casing) name for each category from a census
 * index, sorted to match the host's `getCategories` convention. One name per
 * category (the census already de-dupes by slug).
 * @param {Array<{name:string}>} censusIndex - output of censusFromContentDir / indexCategories
 * @returns {string[]} sorted canonical names
 */
export function canonicalNamesFromCensus(censusIndex) {
  return (censusIndex || [])
    .map((c) => c && c.name)
    .filter((name) => typeof name === "string" && name.length > 0)
    .toSorted();
}

/**
 * Refresh `Indiekit.publication.categories` from the content census. Mutates the
 * live publication object in place. Never throws — on any failure it logs and
 * leaves the existing list untouched (a normalize/typeahead source must never
 * take down a boot or a save).
 *
 * Guards: skips when there is no content dir or publication object, and will NOT
 * clobber a configured list with `[]` (an empty census = transient/first-boot;
 * keep whatever was there).
 *
 * @param {object} Indiekit - host instance
 * @param {object} [options]
 * @param {string} [options.contentDir] - override (defaults to app config)
 * @param {(dir:string)=>Array} [options.censusFn] - injectable census (tests)
 * @returns {string[]} the names applied, or `[]` if skipped/failed
 */
export function refreshPublicationCategories(Indiekit, options = {}) {
  const { contentDir, censusFn = censusFromContentDir } = options;
  try {
    const dir = contentDir || Indiekit?.config?.application?.contentDir;
    if (!dir || !Indiekit?.publication) return [];
    const names = canonicalNamesFromCensus(censusFn(dir));
    if (names.length === 0) return []; // don't clobber a configured list with []
    Indiekit.publication.categories = names;
    return names;
  } catch (error) {
    console.warn(
      `[site-config] publication.categories refresh failed: ${error.message}`,
    );
    return [];
  }
}
