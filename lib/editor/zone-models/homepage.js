/**
 * Homepage zone-model — the first concrete zone-model (Phase 6.2 foundation).
 *
 * A zone-model is the per-surface contract for the constrained editor: it maps
 * a v4 composition tree ↔ the editor's flat `{ arrangement, hero, main,
 * sidebar, footer }` zones shape. This module holds the homepage surface's
 * model, extracted VERBATIM from the original `lib/editor/zones.js` so behavior
 * is byte-for-byte unchanged.
 *
 * STRICTNESS IS THE CONTRACT: `recognize` matches precisely the migrator's
 * shapes (lib/storage/migrate-v3-to-v4.js `buildHomepageTree`) and nothing
 * else. Anything off-shape returns `{ custom: true, tree }` — the editor renders
 * a read-only notice instead. The failure mode of wrongly-custom is a read-only
 * editor; the failure mode of wrongly-recognized is silent data corruption on
 * the next save (the rebuild would drop whatever the recognizer glossed over).
 * When in doubt, custom. Never throws, never lossy-coerces.
 *
 * Pure module: no db, no Indiekit, no fs.
 * @module editor/zone-models/homepage
 */

// The migrator's variant tokens, replicated EXACTLY (buildHomepageTree).
const COLUMNS_VARIANT = Object.freeze({ width: "default", columns: "2-1", gap: "loose" });
const COMPLEMENTARY_VARIANT = Object.freeze({ sticky: true });

// Exact own-key sets per recognized container slot. Extra keys ⇒ custom:
// build rebuilds containers from scratch, so any unrecognized key
// would be silently dropped on save.
const PLAIN_STACK_KEYS = ["block", "id", "as", "role", "children"];
const VARIANT_CONTAINER_KEYS = ["block", "id", "as", "role", "variant", "children"];

/** @param {unknown} value @returns {boolean} */
const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Flat deep-equal for variant objects (variants are single-level maps of
 * primitive tokens).
 * @param {unknown} actual
 * @param {object} expected
 * @returns {boolean}
 */
function variantEquals(actual, expected) {
  if (!isPlainObject(actual)) return false;
  const keys = Object.keys(actual);
  if (keys.length !== Object.keys(expected).length) return false;
  return keys.every((key) => actual[key] === expected[key]);
}

/**
 * Recognize a container node in one of the migrator's exact slot shapes.
 * @param {unknown} node
 * @param {object} shape
 * @param {string} shape.as
 * @param {string} shape.role
 * @param {object} [shape.variant] Required variant (exact match); absent ⇒
 *   the node must carry NO variant key at all
 * @returns {boolean}
 */
function matchesContainer(node, { as, role, variant }) {
  if (!isPlainObject(node) || node.block !== "container") return false;
  if (typeof node.id !== "string" || node.id === "") return false;
  if (node.as !== as || node.role !== role) return false;
  if (!Array.isArray(node.children)) return false;
  const expectedKeys = variant ? VARIANT_CONTAINER_KEYS : PLAIN_STACK_KEYS;
  const keys = Object.keys(node).sort();
  if (keys.length !== expectedKeys.length || !expectedKeys.every((k) => keys.includes(k))) {
    return false;
  }
  if (variant && !variantEquals(node.variant, variant)) return false;
  return true;
}

/** Zone children must be section nodes only — a nested container ⇒ custom. */
const allSections = (children) =>
  children.every((child) => isPlainObject(child) && child.block === "section");

/**
 * Map a v4 composition tree to the editor's constrained zones shape.
 *
 * Recognized shape (and ONLY this shape): root stack whose children are
 * `[optional hero section, main-stack OR columns(2-1)[main-stack,
 * sticky complementary stack], optional non-empty contentinfo stack]`.
 * (An EMPTY contentinfo stack is custom: the migrator never emits one and
 * the rebuild drops empty footers, so recognizing it would be lossy.)
 *
 * @param {unknown} tree Composition tree (untrusted plain data)
 * @returns {object} `{ arrangement, hero, main, sidebar, footer,
 *   _containerIds }` on recognition, else `{ custom: true, tree }`
 */
function recognize(tree) {
  const custom = { custom: true, tree };
  if (!matchesContainer(tree, { as: "stack", role: "root" })) return custom;

  const children = tree.children;
  let index = 0;

  // Optional hero: a section of type "hero" BEFORE the main/columns
  // container. Any other root-level section is off-shape.
  let hero = null;
  const first = children[index];
  if (isPlainObject(first) && first.block === "section") {
    if (first.type !== "hero") return custom;
    hero = first;
    index += 1;
  }

  // Required: main stack OR the 2-1 columns container.
  const layout = children[index];
  index += 1;
  let arrangement;
  let main;
  let sidebar = [];
  const _containerIds = { root: tree.id };

  if (matchesContainer(layout, { as: "stack", role: "main" })) {
    arrangement = "stack";
    main = layout.children;
    _containerIds.main = layout.id;
  } else if (
    matchesContainer(layout, { as: "columns", role: "region", variant: COLUMNS_VARIANT }) &&
    layout.children.length === 2 &&
    matchesContainer(layout.children[0], { as: "stack", role: "main" }) &&
    matchesContainer(layout.children[1], {
      as: "stack",
      role: "complementary",
      variant: COMPLEMENTARY_VARIANT,
    })
  ) {
    arrangement = "sidebar-right";
    main = layout.children[0].children;
    sidebar = layout.children[1].children;
    _containerIds.columns = layout.id;
    _containerIds.main = layout.children[0].id;
    _containerIds.sidebar = layout.children[1].id;
  } else {
    return custom;
  }

  // Optional trailing contentinfo stack — must be non-empty (see above).
  let footer = [];
  if (index < children.length) {
    const last = children[index];
    index += 1;
    if (!matchesContainer(last, { as: "stack", role: "contentinfo" })) return custom;
    if (last.children.length === 0) return custom;
    footer = last.children;
    _containerIds.footer = last.id;
  }

  // Nothing may follow; zone children must be sections only.
  if (index !== children.length) return custom;
  if (!allSections(main) || !allSections(sidebar) || !allSections(footer)) return custom;

  return { arrangement, hero, main: [...main], sidebar: [...sidebar], footer: [...footer], _containerIds };
}

/**
 * Rebuild a composition tree from the zones shape. The inverse of
 * `recognize` — for any recognized tree,
 * `build(recognize(t)) deep-equals t` INCLUDING ids: container ids
 * come from `_containerIds` (minted fresh via `idFactory("c")` only when
 * absent), and section nodes pass through untouched, carrying their own ids.
 *
 * Variant tokens replicate the migrator's exactly (columns
 * `{width, columns: "2-1", gap}`, complementary `{sticky: true}`).
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
  const stack = (key, role, children, variant) => ({
    block: "container",
    id: containerId(key),
    as: "stack",
    role,
    ...(variant ? { variant: { ...variant } } : {}),
    children,
  });

  const children = [];
  if (zones.hero) children.push(zones.hero);

  const main = stack("main", "main", [...zones.main]);
  if (zones.arrangement === "sidebar-right") {
    children.push({
      block: "container",
      id: containerId("columns"),
      as: "columns",
      role: "region",
      variant: { ...COLUMNS_VARIANT },
      children: [main, stack("sidebar", "complementary", [...zones.sidebar], COMPLEMENTARY_VARIANT)],
    });
  } else {
    children.push(main);
  }

  // Migrator parity: an empty footer emits NO contentinfo container, even
  // when a stale footer container id lingers in _containerIds.
  if (zones.footer.length > 0) {
    children.push(stack("footer", "contentinfo", [...zones.footer]));
  }

  return { block: "container", id: containerId("root"), as: "stack", role: "root", children };
}

/**
 * The homepage zone-model. `recognize`/`build` are `this`-free standalone
 * functions (the originals never used `this`), so they can be referenced
 * directly or destructured without binding.
 */
export const homepageZoneModel = {
  zones: ["hero", "main", "sidebar", "footer"],
  regionMap: { hero: "hero", main: "main", sidebar: "sidebar", footer: "footer" },
  recognize,
  build,
};
