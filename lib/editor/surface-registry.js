import { homepageZoneModel } from "./zone-models/homepage.js";
import { listingZoneModel } from "./zone-models/listing.js";
import { LAYOUT_PRESETS } from "../presets/layout-presets.js";
import { buildHomepageTree } from "../storage/migrate-v3-to-v4.js";

/** @typedef {{ routeKey:string, surfaceId:string, kind:string, surfaceFilter:string,
 *   editorView:string, hubKey:string, zoneModel:object, recipes:object[],
 *   treeBuilder:(preset:object, idFactory:Function)=>object|null,
 *   arrangements?:string[], supportsLivePreview?:boolean,
 *   editorTitleKey:string, editorIntroKey:string }} SurfaceEntry
 *   `arrangements` is the surface's arrangement-axis capability: the ordered
 *   list of valid arrangement values (e.g. ["stack","sidebar-right"]). ABSENT/
 *   undefined ⇒ the surface has NO arrangement axis (a sidebar-only listing
 *   surface omits it), and the /arrangement route 404s for it.
 *   `supportsLivePreview` is the live-preview capability (6.3 #31 stopgap):
 *   the preview is a SINGLE shared slot (preview-draft.json + one token on the
 *   siteConfig singleton, not per-surface), so only ONE surface may own it.
 *   ABSENT/undefined ⇒ the surface has NO live preview (the listing surface
 *   omits it): the /:surface/preview route 404s for it (so it can't overwrite
 *   the shared homepage slot) and the editor view hides the preview pane.
 *   `editorTitleKey`/`editorIntroKey` are the i18n keys for the editor's H1 +
 *   intro copy (6.3 #28): per-surface so the shared view doesn't hardcode
 *   "Homepage design" on every surface. */

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
    // Arrangement capability: homepage can collapse its sidebar into main.
    arrangements: Object.freeze(["stack", "sidebar-right"]),
    // Live-preview capability: homepage OWNS the shared preview slot (6.3 #31).
    supportsLivePreview: true,
    // Editor copy (6.3 #28): the EXISTING homepage strings (byte-identical).
    editorTitleKey: "siteConfig.design.editor.title",
    editorIntroKey: "siteConfig.design.editor.description",
  }),
  listing: Object.freeze({
    routeKey: "listing",
    surfaceId: "collection:default",
    kind: "collection",
    surfaceFilter: "collection",
    // SHARED editor view (T4 parameterizes it to render sidebar-only).
    editorView: "site-config-design-homepage",
    hubKey: "listing",
    zoneModel: listingZoneModel,
    // Sidebar-only: no layout presets and no tree builder ⇒ /apply-recipe 404s.
    recipes: [],
    treeBuilder: null,
    // No `arrangements` field ⇒ no arrangement axis (per T2); /arrangement 404s.
    // No `supportsLivePreview` field ⇒ no live preview (6.3 #31 stopgap): the
    // /preview route 404s and the editor hides the preview pane (the shared
    // preview slot is homepage-only; a per-surface preview is a follow-up).
    editorTitleKey: "siteConfig.design.editor.listingTitle",
    editorIntroKey: "siteConfig.design.editor.listingDescription",
  }),
  // 6.4 adds `posttype`, 6.5 `pages`.
});

/** @param {string} routeKey @returns {SurfaceEntry | null} */
export function getSurface(routeKey) {
  return Object.hasOwn(SURFACES, routeKey) ? SURFACES[routeKey] : null;
}
