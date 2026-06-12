/**
 * Immutable block operations over the editor's zones shape (editor/zones.js).
 * Every op takes `(zones, args)` and returns fresh objects — the input zones
 * are NEVER mutated (undo/redo and optimistic UI both depend on it). Section
 * nodes are treated as immutable values: ops move references around and only
 * `updateBlockConfig` replaces a node (with a fresh object).
 *
 * Catalog-free by design: `multiple: false` enforcement and zone-legality
 * (placement.regions) are the CONTROLLER's job — it owns the catalog. The
 * only structural invariant enforced here is the hero SLOT (single occupant,
 * `{ error: "hero-occupied" }` when taken).
 *
 * Error results carry the input-equivalent zones (fresh) plus an `error`
 * code; success results carry `{ zones }` (and `removed` for removeBlock).
 *
 * Pure module: no db, no Indiekit, no fs.
 * @module editor/block-ops
 */

const LIST_ZONES = ["main", "sidebar", "footer"];

/** Fresh top-level copy: new zone arrays, copied _containerIds. */
const cloneZones = (zones) => ({
  ...zones,
  main: [...zones.main],
  sidebar: [...zones.sidebar],
  footer: [...zones.footer],
  ...(zones._containerIds ? { _containerIds: { ...zones._containerIds } } : {}),
});

/**
 * Locate a block by id across the hero slot and all three lists.
 * @param {object} zones
 * @param {string} blockId
 * @returns {{ node: object, zone: string, index: number } | null}
 */
function findBlock(zones, blockId) {
  if (zones.hero && zones.hero.id === blockId) {
    return { node: zones.hero, zone: "hero", index: 0 };
  }
  for (const zone of LIST_ZONES) {
    const index = zones[zone].findIndex((node) => node.id === blockId);
    if (index !== -1) return { node: zones[zone][index], zone, index };
  }
  return null;
}

/**
 * Append a new section node to a zone (or set the hero slot).
 * @param {object} zones
 * @param {object} args
 * @param {string} args.zone "hero" | "main" | "sidebar" | "footer"
 * @param {string} args.type Block type (catalog id)
 * @param {object} [args.config]
 * @param {(prefix: string) => string} args.idFactory
 * @returns {{ zones: object, error?: string }}
 */
export function addBlock(zones, { zone, type, config, idFactory }) {
  const next = cloneZones(zones);
  const node = { block: "section", id: idFactory("b"), type, v: 0, config: config ?? {} };
  if (zone === "hero") {
    if (next.hero) return { zones: cloneZones(zones), error: "hero-occupied" };
    next.hero = node;
    return { zones: next };
  }
  next[zone].push(node);
  return { zones: next };
}

/**
 * Remove a block by id, reporting where it was (for restoreBlock undo).
 * @param {object} zones
 * @param {{ blockId: string }} args
 * @returns {{ zones: object, removed?: { node: object, zone: string, index: number }, error?: string }}
 */
export function removeBlock(zones, { blockId }) {
  const found = findBlock(zones, blockId);
  if (!found) return { zones: cloneZones(zones), error: "not-found" };
  const next = cloneZones(zones);
  if (found.zone === "hero") next.hero = null;
  else next[found.zone].splice(found.index, 1);
  return { zones: next, removed: found };
}

/**
 * Put a removed block back (undo). List indexes are clamped to the current
 * zone length; restoring into an occupied hero slot errors.
 * @param {object} zones
 * @param {{ node: object, zone: string, index: number }} args
 * @returns {{ zones: object, error?: string }}
 */
export function restoreBlock(zones, { node, zone, index }) {
  const next = cloneZones(zones);
  if (zone === "hero") {
    if (next.hero) return { zones: cloneZones(zones), error: "hero-occupied" };
    next.hero = node;
    return { zones: next };
  }
  const clamped = Math.max(0, Math.min(index, next[zone].length));
  next[zone].splice(clamped, 0, node);
  return { zones: next };
}

/**
 * Move a block one step up/down within its zone. Edge moves (and the hero
 * slot, which has no order) are no-ops returning equal-but-fresh zones.
 * @param {object} zones
 * @param {{ blockId: string, direction: "up" | "down" }} args
 * @returns {{ zones: object, error?: string }}
 */
export function moveBlock(zones, { blockId, direction }) {
  const found = findBlock(zones, blockId);
  if (!found) return { zones: cloneZones(zones), error: "not-found" };
  const next = cloneZones(zones);
  if (found.zone === "hero") return { zones: next }; // single slot — nothing to reorder
  const list = next[found.zone];
  const target = direction === "up" ? found.index - 1 : found.index + 1;
  if (target < 0 || target >= list.length) return { zones: next }; // edge no-op
  [list[found.index], list[target]] = [list[target], list[found.index]];
  return { zones: next };
}

/**
 * Move a block to another zone (appended; hero slot when zone is "hero").
 * Hero↔list moves are allowed MECHANICALLY — whether a block type may live
 * in the target zone is the controller's catalog check.
 * @param {object} zones
 * @param {{ blockId: string, zone: string }} args
 * @returns {{ zones: object, error?: string }}
 */
export function moveBlockToZone(zones, { blockId, zone }) {
  const found = findBlock(zones, blockId);
  if (!found) return { zones: cloneZones(zones), error: "not-found" };
  // Check the target BEFORE detaching, so an error never loses the block.
  if (zone === "hero" && zones.hero && zones.hero.id !== blockId) {
    return { zones: cloneZones(zones), error: "hero-occupied" };
  }
  const next = cloneZones(zones);
  if (found.zone === "hero") next.hero = null;
  else next[found.zone].splice(found.index, 1);
  if (zone === "hero") next.hero = found.node;
  else next[zone].push(found.node);
  return { zones: next };
}

/**
 * Replace a block's config (fresh node; id/type/v untouched).
 * @param {object} zones
 * @param {{ blockId: string, config: object }} args
 * @returns {{ zones: object, error?: string }}
 */
export function updateBlockConfig(zones, { blockId, config }) {
  const found = findBlock(zones, blockId);
  if (!found) return { zones: cloneZones(zones), error: "not-found" };
  const next = cloneZones(zones);
  const updated = { ...found.node, config };
  if (found.zone === "hero") next.hero = updated;
  else next[found.zone][found.index] = updated;
  return { zones: next };
}
