/**
 * Immutable block operations over the editor's zones shape (editor/zones.js).
 * Every op takes `(zones, args)` and returns fresh objects — the input zones
 * are NEVER mutated (undo/redo and optimistic UI both depend on it). Section
 * nodes are treated as immutable values: ops move references around and only
 * `updateBlockConfig` replaces a node (with a fresh object).
 *
 * Catalog-free by design: `multiple: false` enforcement and zone-legality
 * (placement.regions) are the CONTROLLER's job — it owns the catalog. The
 * only structural invariant enforced here is the single-slot zone (single
 * occupant, `{ error: "hero-occupied" }` when taken — e.g. the homepage hero).
 *
 * Surface-agnostic: the ops introspect WHATEVER zones the input object carries
 * rather than hardcoding homepage zone names. A zone whose value is an Array is
 * a list (ordered, many blocks); a zone whose value is a node-or-null is a
 * single slot. The homepage shape (hero slot + main/sidebar/footer lists +
 * arrangement/_containerIds metadata) and the listing shape (sidebar list +
 * _containerIds, no hero/main/footer) are both handled by the same code.
 *
 * Error results carry the input-equivalent zones (fresh) plus an `error`
 * code; success results carry `{ zones }` (and `removed` for removeBlock).
 *
 * Pure module: no db, no Indiekit, no fs.
 * @module editor/block-ops
 */

/**
 * Keys on a zones object that are NOT editable zones. The introspective ops
 * skip these so they never treat metadata (arrangement string, container-id
 * map) or off-shape `recognize` results (custom/tree) as a zone. Everything
 * else is classified by its VALUE: an Array is a list zone, a node-or-null is
 * a single-slot zone (e.g. the homepage hero).
 */
const NON_ZONE_KEYS = new Set(["arrangement", "_containerIds", "custom", "tree"]);

/** True for own keys that hold a zone value (list or single-slot). */
const isZoneKey = (zones, key) =>
  Object.prototype.hasOwnProperty.call(zones, key) && !NON_ZONE_KEYS.has(key);

/**
 * Fresh top-level copy. Each own zone key whose value is an Array is deep-copied
 * (new array, same node references); single-slot (node|null) values are
 * immutable references the spread copies fine; `_containerIds` is cloned.
 * Surface-agnostic: copies WHATEVER zones the object actually has — homepage
 * (hero/main/sidebar/footer) and listing (sidebar only) alike.
 */
const cloneZones = (zones) => {
  const next = { ...zones };
  for (const key of Object.keys(zones)) {
    if (isZoneKey(zones, key) && Array.isArray(zones[key])) {
      next[key] = [...zones[key]];
    }
  }
  if (zones._containerIds) next._containerIds = { ...zones._containerIds };
  return next;
};

/**
 * Locate a block by id across whatever zones the object contains. List zones
 * (Array values) are searched by index; single-slot zones (node values) match
 * when their `.id` equals blockId. Non-zone keys are skipped.
 * @param {object} zones
 * @param {string} blockId
 * @returns {{ node: object, zone: string, index: number } | null}
 */
function findBlock(zones, blockId) {
  for (const zone of Object.keys(zones)) {
    if (!isZoneKey(zones, zone)) continue;
    const value = zones[zone];
    if (Array.isArray(value)) {
      const index = value.findIndex((node) => node.id === blockId);
      if (index !== -1) return { node: value[index], zone, index };
    } else if (value && value.id === blockId) {
      return { node: value, zone, index: 0 };
    }
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
  // List vs single-slot is decided by the CURRENT value at the target zone:
  // an Array is a list (push); anything else is a single slot (node|null).
  if (Array.isArray(next[zone])) {
    next[zone].push(node);
    return { zones: next };
  }
  if (next[zone]) return { zones: cloneZones(zones), error: "hero-occupied" };
  next[zone] = node;
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
  if (Array.isArray(next[found.zone])) next[found.zone].splice(found.index, 1);
  else next[found.zone] = null;
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
  // Single-slot target (node|null) when the current value is not an Array.
  if (!Array.isArray(next[zone])) {
    if (next[zone]) return { zones: cloneZones(zones), error: "hero-occupied" };
    next[zone] = node;
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
  if (!Array.isArray(next[found.zone])) return { zones: next }; // single slot — nothing to reorder
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
  // Single-slot target (node|null) when the current value is not an Array.
  const targetIsSlot = !Array.isArray(zones[zone]);
  // Check the target BEFORE detaching, so an error never loses the block.
  if (targetIsSlot && zones[zone] && zones[zone].id !== blockId) {
    return { zones: cloneZones(zones), error: "hero-occupied" };
  }
  const next = cloneZones(zones);
  if (Array.isArray(next[found.zone])) next[found.zone].splice(found.index, 1);
  else next[found.zone] = null;
  if (targetIsSlot) next[zone] = found.node;
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
  if (Array.isArray(next[found.zone])) next[found.zone][found.index] = updated;
  else next[found.zone] = updated;
  return { zones: next };
}
