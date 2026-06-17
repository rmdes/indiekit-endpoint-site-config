import { homepageZoneModel } from "./zone-models/homepage.js";
import { LAYOUT_PRESETS } from "../presets/layout-presets.js";
import { buildHomepageTree } from "../storage/migrate-v3-to-v4.js";

/** @typedef {{ routeKey:string, surfaceId:string, kind:string, surfaceFilter:string,
 *   editorView:string, hubKey:string, zoneModel:object, recipes:object[],
 *   treeBuilder:(preset:object, idFactory:Function)=>object|null }} SurfaceEntry */

export const SURFACES = Object.freeze({
  homepage: Object.freeze({
    routeKey: "homepage",
    surfaceId: "homepage",
    kind: "homepage",
    surfaceFilter: "homepage",
    editorView: "site-config-design-homepage",
    hubKey: "homepage",
    zoneModel: homepageZoneModel,
    recipes: LAYOUT_PRESETS,
    treeBuilder: buildHomepageTree,
  }),
  // 6.3 adds `listing` (surfaceId "collection:default"), 6.4 `posttype`, 6.5 `pages`.
});

/** @param {string} routeKey @returns {SurfaceEntry | null} */
export function getSurface(routeKey) {
  return Object.hasOwn(SURFACES, routeKey) ? SURFACES[routeKey] : null;
}
