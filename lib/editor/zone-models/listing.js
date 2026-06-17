/**
 * Listing zone-model — the SIDEBAR-ONLY surface (Phase 6.3).
 *
 * A zone-model is the per-surface contract for the constrained editor: it maps
 * a v4 composition tree ↔ the editor's flat zones shape. The listing surface
 * edits the `collection:default` composition, which the migrator seeds as a
 * single complementary (sidebar) zone — no hero/main/footer, no arrangement:
 *
 *   stack(root, [stack(complementary, <sections>, { sticky: true })])
 *
 * (migrate-v3-to-v4.js `sidebarComposition` :150-163 → `stack` :71-78).
 *
 * STRICTNESS IS THE CONTRACT (see homepage.js for the full rationale):
 * `recognize` matches precisely that seed shape and nothing else. Anything
 * off-shape returns `{ custom: true, tree }` and the editor renders a
 * read-only notice. The failure mode of wrongly-custom is a read-only editor;
 * the failure mode of wrongly-recognized is silent data corruption on the next
 * save. When in doubt, custom. Never throws, never lossy-coerces.
 *
 * Pure module: no db, no Indiekit, no fs.
 * @module editor/zone-models/listing
 */

import { allSections, matchesContainer, COMPLEMENTARY_VARIANT } from "./_shared.js";

/**
 * Map a v4 composition tree to the editor's sidebar-only zones shape.
 *
 * Recognized shape (and ONLY this shape): a root stack whose ONLY child is a
 * sticky complementary stack whose children are all sections.
 *
 * @param {unknown} tree Composition tree (untrusted plain data)
 * @returns {object} `{ sidebar, _containerIds }` on recognition, else
 *   `{ custom: true, tree }`
 */
function recognize(tree) {
  const custom = { custom: true, tree };
  if (!matchesContainer(tree, { as: "stack", role: "root" })) return custom;

  const children = tree.children;
  // Exactly one child: the complementary sidebar stack. Anything else
  // (zero children, extra children) is off-shape.
  if (children.length !== 1) return custom;

  const complementary = children[0];
  if (
    !matchesContainer(complementary, {
      as: "stack",
      role: "complementary",
      variant: COMPLEMENTARY_VARIANT,
    })
  ) {
    return custom;
  }

  // Zone children must be sections only — a nested container ⇒ custom.
  if (!allSections(complementary.children)) return custom;

  return {
    sidebar: [...complementary.children],
    _containerIds: { root: tree.id, sidebar: complementary.id },
  };
}

/**
 * Rebuild a composition tree from the sidebar-only zones shape. The inverse of
 * `recognize` — for any recognized tree, `build(recognize(t)) deep-equals t`
 * INCLUDING ids: container ids come from `_containerIds` (minted fresh via
 * `idFactory("c")` only when absent), and section nodes pass through
 * untouched, carrying their own ids.
 *
 * Migrator parity: an EMPTY sidebar emits NO complementary container — the
 * root stack has empty children (the migrator only creates a doc when the
 * sidebar is non-empty, so this is the sensible inverse).
 *
 * @param {object} zones Editor zones shape (NOT a custom result)
 * @param {object} [options]
 * @param {(prefix: string) => string} [options.idFactory] Id factory for
 *   containers missing from `_containerIds` (new compositions)
 * @returns {object} v4 composition tree (root container)
 */
function build(zones, options = {}) {
  const { idFactory } = options;
  const ids = zones._containerIds ?? {};
  const containerId = (key) => ids[key] ?? idFactory("c");

  const children =
    zones.sidebar.length > 0
      ? [
          {
            block: "container",
            id: containerId("sidebar"),
            as: "stack",
            role: "complementary",
            variant: { ...COMPLEMENTARY_VARIANT },
            children: [...zones.sidebar],
          },
        ]
      : [];

  return { block: "container", id: containerId("root"), as: "stack", role: "root", children };
}

/**
 * The listing zone-model. `recognize`/`build` are `this`-free standalone
 * functions, so they can be referenced directly or destructured without
 * binding. `zoneModel: true` is the explicit discriminant the zones.js
 * overload guard routes on.
 */
export const listingZoneModel = {
  zoneModel: true,
  zones: ["sidebar"],
  // regionMap translates the editor ZONE NAME → the block PLACEMENT REGION
  // name (block-entry.js REGIONS vocab: hero/main/sidebar/footer). It is NOT
  // the composition tree container ROLE ("complementary", set in build()).
  // Sidebar-capable blocks declare `regions:["sidebar"]`, so editor zone
  // "sidebar" maps to placement region "sidebar" (identity, like homepage's
  // map). Mapping to "complementary" here would make placementAllows reject
  // EVERY block (none declare region "complementary") → an unusable editor.
  regionMap: { sidebar: "sidebar" },
  recognize,
  build,
};
