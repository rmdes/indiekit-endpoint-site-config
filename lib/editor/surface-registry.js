import { homepageZoneModel } from "./zone-models/homepage.js";
import { sidebarZoneModel } from "./zone-models/sidebar.js";
import { LAYOUT_PRESETS } from "../presets/layout-presets.js";
import { buildHomepageTree } from "../storage/migrate-v3-to-v4.js";

/** @typedef {{ routeKey:string, surfaceId?:string, kind:string, surfaceFilter:string,
 *   editorView:string, hubKey:string, zoneModel:object, recipes:object[],
 *   treeBuilder:(preset:object, idFactory:Function)=>object|null,
 *   arrangements?:string[], isCollection?:boolean,
 *   editorTitleKey:string, editorIntroKey:string, editorNounKey:string }} SurfaceEntry
 *   `surfaceId` is a STATIC field ONLY for singleton surfaces (homepage,
 *   listing, posttype) — it names the single composition doc. COLLECTION
 *   surfaces (`isCollection: true`, e.g. 6.5 pages) OMIT it: their surfaceId
 *   (`page:<slug>`) is request-derived and injected onto a per-request clone of
 *   the frozen entry (design.js), never written onto the frozen registry entry.
 *   `arrangements` is the surface's arrangement-axis capability: the ordered
 *   list of valid arrangement values (e.g. ["stack","sidebar-right"]). ABSENT/
 *   undefined ⇒ the surface has NO arrangement axis (a sidebar-only listing
 *   surface omits it), and the /arrangement route 404s for it.
 *   Live preview is now a per-surface capability for EVERY surface (#32): each
 *   surface owns an ISOLATED slot keyed by routeKey
 *   (previews.<routeKey>.{token,revision} + preview-<routeKey>.json), so the
 *   old single-owner `supportsLivePreview` gate is gone — every surface renders
 *   the preview pane and previews its own slot.
 *   `editorTitleKey`/`editorIntroKey` are the i18n keys for the editor's H1 +
 *   intro copy (6.3 #28): per-surface so the shared view doesn't hardcode
 *   "Homepage design" on every surface.
 *   `editorNounKey` (#39) is the i18n key for the surface's short noun
 *   ("homepage"/"blog listing"/"post sidebar"), interpolated as {{surface}}
 *   into the shared confirm/draft/empty/custom/error copy so those strings
 *   don't hardcode "homepage" on the listing/postType surfaces. */

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
    // Editor copy (6.3 #28): the EXISTING homepage strings (byte-identical).
    editorTitleKey: "siteConfig.design.editor.title",
    editorIntroKey: "siteConfig.design.editor.description",
    editorNounKey: "siteConfig.design.editor.surfaceNoun.homepage",
  }),
  listing: Object.freeze({
    routeKey: "listing",
    surfaceId: "collection:default",
    kind: "collection",
    surfaceFilter: "collection",
    // SHARED editor view (T4 parameterizes it to render sidebar-only).
    editorView: "site-config-design-homepage",
    hubKey: "listing",
    zoneModel: sidebarZoneModel,
    // Sidebar-only: no layout presets and no tree builder ⇒ /apply-recipe 404s.
    recipes: [],
    treeBuilder: null,
    // No `arrangements` field ⇒ no arrangement axis (per T2); /arrangement 404s.
    // Live preview is per-surface (#32): listing previews its OWN slot.
    editorTitleKey: "siteConfig.design.editor.listingTitle",
    editorIntroKey: "siteConfig.design.editor.listingDescription",
    editorNounKey: "siteConfig.design.editor.surfaceNoun.listing",
  }),
  posttype: Object.freeze({
    // CASING TRAP (6.4 CRITICAL): the route segment + hub key are lowercase
    // "posttype" (URL /site-config/design/posttype, + the hub thumbnail key);
    // the composition kind + surfaceFilter are camelCase "postType" (matching
    // the placement.surfaces strings in builtin-blocks.js and the SURFACES
    // vocab in lib/discovery/block-entry.js). Mismatching the case empties the
    // block picker — the same class of bug as the 6.3 listing CRITICAL.
    routeKey: "posttype",
    surfaceId: "posttype:default",
    kind: "postType",
    surfaceFilter: "postType",
    // SHARED editor view (parameterized to render sidebar-only via zoneNames).
    editorView: "site-config-design-homepage",
    hubKey: "posttype",
    // Shared sidebar-only zone-model (same object the listing surface uses).
    zoneModel: sidebarZoneModel,
    // Sidebar-only: no layout presets and no tree builder ⇒ /apply-recipe 404s.
    recipes: [],
    treeBuilder: null,
    // No `arrangements` field ⇒ no arrangement axis (like listing); /arrangement 404s.
    // Live preview is per-surface (#32): posttype previews its OWN slot.
    editorTitleKey: "siteConfig.design.editor.posttypeTitle",
    editorIntroKey: "siteConfig.design.editor.posttypeDescription",
    editorNounKey: "siteConfig.design.editor.surfaceNoun.posttype",
  }),
  // 6.5 — `pages`: a COLLECTION surface (one entry, N `page:<slug>` docs).
  // Unlike every prior SINGLETON entry, `pages` has NO static `surfaceId` — a
  // page's surfaceId is `page:<slug>`, derived per-request from the route slug
  // (design.js injects it onto a per-request CLONE of this frozen entry; the
  // frozen original is never mutated). `isCollection: true` marks the
  // exception. Pages are FULL-PAGE compositions (hero/main/sidebar/footer), so
  // they reuse the homepage multi-zone model + the arrangement axis, NOT the
  // sidebar-only listing/posttype model.
  pages: Object.freeze({
    routeKey: "pages",
    // NO `surfaceId` field — request-derived ("page:" + slug). See D2.
    kind: "page",
    // Vocab casing (6.4 trap): "standalone" is the catalog token (block-entry.js
    // SURFACES + builtin-blocks placement.surfaces). Mismatch ⇒ empty picker.
    surfaceFilter: "standalone",
    // SHARED editor view (same one homepage/listing/posttype reuse).
    editorView: "site-config-design-homepage",
    hubKey: "pages",
    // Full-page model (hero/main/sidebar/footer) — pages are full-page comps.
    zoneModel: homepageZoneModel,
    // Layout choice like homepage (recipes + tree builder + arrangement axis).
    recipes: LAYOUT_PRESETS,
    treeBuilder: buildHomepageTree,
    arrangements: Object.freeze(["stack", "sidebar-right"]),
    // Collection marker (D1): N docs, one surface — distinguishes pages from the
    // singleton surfaces whose surfaceId names a single doc.
    isCollection: true,
    editorTitleKey: "siteConfig.design.editor.pagesTitle",
    editorIntroKey: "siteConfig.design.editor.pagesDescription",
    editorNounKey: "siteConfig.design.editor.surfaceNoun.pages",
  }),
});

/** @param {string} routeKey @returns {SurfaceEntry | null} */
export function getSurface(routeKey) {
  return Object.hasOwn(SURFACES, routeKey) ? SURFACES[routeKey] : null;
}
