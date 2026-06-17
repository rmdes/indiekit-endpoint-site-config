/**
 * Zones mapping — the editor's constrained view over the recursive v4
 * composition tree. The editor never edits the tree directly: it edits a flat
 * `{ arrangement, hero, main, sidebar, footer }` shape, and this module maps
 * between that shape and the EXACT tree shapes a surface's zone-model knows.
 *
 * As of Phase 6.2 the recognition/rebuild logic lives in per-surface
 * **zone-model** objects (`lib/editor/zone-models/*.js`), each exposing
 * `recognize(tree)` / `build(zones, options)`. These two functions are thin
 * generic wrappers that delegate to a model. The DEFAULT model is the homepage
 * model, so legacy single-arg / options-as-2nd-arg call sites keep working
 * unchanged until later 6.2 tasks parameterize the controller.
 *
 * STRICTNESS IS THE CONTRACT lives in each model — see
 * `lib/editor/zone-models/homepage.js` for the rationale. Never throws, never
 * lossy-coerces.
 *
 * Pure module: no db, no Indiekit, no fs.
 * @module editor/zones
 */

import { homepageZoneModel } from "./zone-models/homepage.js";

/**
 * True when `value` is a zone-model. The protocol is the EXPLICIT
 * `zoneModel: true` discriminant — NOT duck-typing on `recognize`/`build`
 * method names. This closes the window where an options object that happens
 * to carry a `build`/`recognize` key would be misclassified as a model,
 * silently dropping the real options (e.g. `idFactory` → undefined ids).
 * Every per-surface zone-model author MUST set `zoneModel: true`.
 * @param {unknown} value
 * @returns {boolean}
 */
const isZoneModel = (value) =>
  Boolean(value) && typeof value === "object" && value.zoneModel === true;

/**
 * Map a v4 composition tree to the editor's constrained zones shape via a
 * zone-model. Defaults to the homepage model.
 *
 * @param {unknown} tree Composition tree (untrusted plain data)
 * @param {object} [model] Zone-model (defaults to `homepageZoneModel`)
 * @returns {object} The model's zones shape, or `{ custom: true, tree }`
 */
export function treeToZones(tree, model = homepageZoneModel) {
  return model.recognize(tree);
}

/**
 * Rebuild a composition tree from the zones shape via a zone-model.
 *
 * OVERLOAD GUARD (load-bearing): the original signature was
 * `zonesToTree(zones, { idFactory })` — options as the 2nd arg. The new
 * signature is `zonesToTree(zones, model, options)`. To keep BOTH call styles
 * working without editing existing call sites (e.g. design.js's
 * `zonesToTree(zones, { idFactory })`), the wrapper sniffs the 2nd arg: if it
 * is NOT a zone-model (no `recognize`/`build`), it is treated as the options
 * bag and the default homepage model is used.
 *
 * @param {object} zones Editor zones shape (NOT a custom result)
 * @param {object} [modelOrOptions] A zone-model, OR (legacy) the options bag
 * @param {object} [maybeOptions] Options bag when a model is passed explicitly
 * @returns {object} v4 composition tree (root container)
 */
export function zonesToTree(zones, modelOrOptions = homepageZoneModel, maybeOptions = {}) {
  if (isZoneModel(modelOrOptions)) {
    return modelOrOptions.build(zones, maybeOptions);
  }
  // Legacy call style: 2nd arg is the options bag, use the default model.
  return homepageZoneModel.build(zones, modelOrOptions ?? {});
}
