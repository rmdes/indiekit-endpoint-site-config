/**
 * /site-config/design — the Phase 4 composition editor (spec §5).
 *
 * Plain-POST, draft-first: every mutating action loads the editable zones
 * (editor/zones.js), applies one immutable block op (editor/block-ops.js),
 * rebuilds the tree and stores it as a DRAFT (storage/composition-draft.js).
 * Nothing reaches the published tree or the on-disk artifact until an
 * explicit publish. No-JS works end to end; D4's JS only enhances
 * (drag-end posts to /move-to-index, otherwise identical forms).
 *
 * RAW-CANDIDATE PUBLISH (accepted advisory): publishDraft persists the raw
 * candidate tree — validateComposition gates, never transforms (the
 * migrator's GATE-NOT-TRANSFORMER convention). That is safe here because
 * every tree this controller writes comes from zonesToTree over its own
 * closed vocabulary, block configs enter only via parseConfigBody (strict
 * schema validation), and the one externally-influenced path — the undo
 * restore payload — re-validates strictly: parseUndoPayload's STRUCTURAL
 * config gate first (config must be a plain object or absent —
 * validateConfigAgainstSchema alone is NOT sufficient here, its non-object
 * leniency treats config:"evil" as empty with ok:true), then catalog type,
 * config keys/values via validateConfigAgainstSchema, zone placement, and a
 * REBUILD of the node from validated parts (v clamped to the catalog
 * version) before it touches the zones.
 *
 * GATE ORDER (D1 advisory): `zone` names are validated against the four
 * editor zones BEFORE any block-ops call — block-ops assumes valid zone
 * keys and would throw on garbage.
 *
 * Custom trees (treeToZones → {custom: true}) render a read-only notice;
 * every POST rejects them with a flash — the failure mode is a read-only
 * editor, never silent coercion of a hand-built tree.
 *
 * Flash is redirect-query based (the tab convention): success flags
 * (?added=1, ?removed=<label>&u=<undo>, …) and ?error=<code> surface as
 * `success`/`error`/`removedLabel` template vars via readFlash.
 *
 * @module controllers/design
 */
import { randomBytes } from "node:crypto";
import express from "express";

import { getSiteConfig } from "../storage/get-site-config.js";
import { saveSiteConfig } from "../storage/save-site-config.js";
import {
  getEditorState,
  saveDraft,
  publishDraft,
  discardDraft,
  createDraftFromTree,
  createPage,
  deleteComposition,
} from "../storage/composition-draft.js";
import {
  getPreviewState,
  ensureToken,
  bumpRevision,
  rotateToken,
} from "../storage/preview-state.js";
import { readBuildStatus } from "../storage/read-build-status.js";
import { writePagesJson } from "../render/write-composition-json.js";
import { writePreviewDraft } from "../render/write-preview-draft.js";
import { treeToZones, zonesToTree } from "../editor/zones.js";
import { getSurface } from "../editor/surface-registry.js";
import {
  addBlock,
  removeBlock,
  restoreBlock,
  moveBlock,
  moveBlockToZone,
  updateBlockConfig,
} from "../editor/block-ops.js";
import { schemaToFields, parseConfigBody } from "../editor/schema-form.js";
import { validateConfigAgainstSchema } from "../validators/block-schema.js";
import { PAGE_SLUG, guardPageRoute } from "../validators/page-route.js";
import { sanitizeCustomHtml } from "../sanitize/custom-html.js";

const HUB_VIEW = "site-config-design";

// Hub card order. Registered surfaces (in SURFACES) render as live cards;
// keys NOT yet in the registry render as disabled placeholders until their
// phase registers them (6.4 posttype, 6.5 pages). The view's thumbnail switch
// keys on homepage/listing/posttype/else, so this order is load-bearing.
const HUB_CARD_ORDER = Object.freeze(["homepage", "listing", "posttype", "pages"]);

// Undo tokens ride in URLs — bound them hard (a typical removed block is a
// few hundred chars; 4k+ means someone is stuffing the query string).
const MAX_UNDO_CHARS = 4096;

const SUCCESS_FLAGS = ["saved", "added", "moved", "restored", "recipe", "published", "discarded", "arranged", "created"];

const defaultIdFactory = (prefix) => `${prefix}_${randomBytes(3).toString("hex")}`;

// ---- pure seams (exported for direct unit testing) ----

/**
 * @param {unknown} value
 * @param {string[] | Set<string>} zones The surface's zone vocabulary
 * @returns {string | null} A valid editor zone or null
 */
export function parseZone(value, zones) {
  const set = zones instanceof Set ? zones : new Set(zones);
  return set.has(value) ? value : null;
}

/**
 * @param {unknown} body
 * @param {string[] | Set<string>} zones The surface's zone vocabulary
 * @returns {{ zone: string, type: string } | { error: string }}
 */
export function parseAddBody(body, zones) {
  const zone = parseZone(body?.zone, zones);
  if (!zone) return { error: "invalid-zone" };
  const type = typeof body?.type === "string" && body.type !== "" ? body.type : null;
  if (!type) return { error: "unknown-type" };
  return { zone, type };
}

/**
 * Catalog gate: may a block of this entry live in this editor zone?
 * @param {object | undefined} entry Catalog entry
 * @param {string} zone Editor zone (already parseZone-validated)
 * @param {object} regionMap Surface zone→region map
 * @returns {boolean}
 */
export function placementAllows(entry, zone, regionMap) {
  const regions = entry?.placement?.regions;
  return Array.isArray(regions) && regions.includes(regionMap[zone]);
}

/**
 * Encode a removeBlock result as a URL-safe undo token.
 * @param {{ node: object, zone: string, index: number }} removed
 * @returns {string | null} base64url token, or null when it exceeds the cap
 *   (undo unavailable — the flash says so, the removal still happens)
 */
export function encodeUndoPayload(removed) {
  const token = Buffer.from(JSON.stringify(removed), "utf8").toString("base64url");
  return token.length <= MAX_UNDO_CHARS ? token : null;
}

/**
 * Decode + shape-check an undo token. Returns null for anything off —
 * oversized, unparseable, non-section node, bad zone, non-integer index.
 * (Semantic validation — catalog type, schema, placement — is the restore
 * handler's job; this is only the structural gate.)
 * @param {unknown} raw
 * @param {string[] | Set<string>} zones The surface's zone vocabulary
 * @returns {{ node: object, zone: string, index: number } | null}
 */
export function parseUndoPayload(raw, zones) {
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_UNDO_CHARS) return null;
  try {
    const payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const { node, zone, index } = payload ?? {};
    if (!node || typeof node !== "object" || Array.isArray(node)) return null;
    if (node.block !== "section") return null;
    if (typeof node.id !== "string" || node.id === "") return null;
    if (typeof node.type !== "string" || node.type === "") return null;
    // Structural config gate (load-bearing): validateConfigAgainstSchema
    // treats non-object configs as EMPTY with only a warning (ok: true), so
    // without this check a tampered token with config: "evil" would pass the
    // restore handler's schema gate and persist the raw string through draft
    // and publish into the artifact. Absent config is fine; present must be
    // a plain object.
    if (
      node.config !== undefined &&
      (node.config === null || typeof node.config !== "object" || Array.isArray(node.config))
    ) {
      return null;
    }
    if (!parseZone(zone, zones)) return null;
    if (!Number.isInteger(index)) return null;
    return { node, zone, index };
  } catch {
    return null;
  }
}

// Stuck-build detection (spec §5.3): a "building" state that has overrun
// max(2 × lastOkDurationSeconds, 120) seconds. The 120s floor matters — the
// first post-boot build is FULL (~2min on the big site) while
// lastOkDurationSeconds usually reflects a fast incremental, so without the
// floor every reboot would flag a false stuck. 60 is the formula's default
// when the duration is absent or garbage (2 × 60 = the floor).
const STUCK_FLOOR_SECONDS = 120;
const STUCK_DEFAULT_OK_SECONDS = 60;

/**
 * Is this build-status object an overdue ("stuck") build?
 *
 * Tolerant by contract: start.sh's crash wrapper drops fields, so a
 * "building" object missing (or garbling) `startedAt` is NEVER stuck — we
 * can't measure how long it has run, and a false "stuck" banner is worse
 * than a quiet one.
 *
 * @param {object | null | undefined} status Parsed build-status content
 * @param {number} nowMs Current epoch ms (injected for tests)
 * @returns {boolean}
 */
export function isStuckBuild(status, nowMs) {
  if (status?.state !== "building") return false;
  const startedAt =
    typeof status.startedAt === "string" ? Date.parse(status.startedAt) : Number.NaN;
  if (Number.isNaN(startedAt)) return false;
  const lastOk =
    typeof status.lastOkDurationSeconds === "number" && status.lastOkDurationSeconds > 0
      ? status.lastOkDurationSeconds
      : STUCK_DEFAULT_OK_SECONDS;
  const thresholdMs = Math.max(2 * lastOk, STUCK_FLOOR_SECONDS) * 1000;
  return nowMs - startedAt > thresholdMs;
}

/**
 * The build-status API/locals shape: the raw file fields + computed `stuck`;
 * absent/corrupt file (reader returned null) → a neutral unknown. An
 * unrecognized `state` passes through untouched — the UI owns rendering
 * anything unrecognized as unknown.
 *
 * `finishedAt` is the one field the view DATE-FORMATS (`| date` → date-fns
 * parseISO, which crashes/garbles on non-ISO values), so an unparseable
 * value is stripped here at the single shared merge point (API + GET
 * locals): the view's ok branch is gated on the field and falls through to
 * the neutral no-time copy instead of crashing the no-JS GET.
 *
 * @param {object | null} status Result of readBuildStatus
 * @param {number} [nowMs=Date.now()]
 * @returns {object} `{ ...status, stuck }` or `{ state: "unknown", stuck: false }`
 */
export function mergeBuildStatus(status, nowMs = Date.now()) {
  if (!status) return { state: "unknown", stuck: false };
  const merged = { ...status, stuck: isStuckBuild(status, nowMs) };
  if (
    merged.finishedAt !== undefined &&
    (typeof merged.finishedAt !== "string" || Number.isNaN(Date.parse(merged.finishedAt)))
  ) {
    delete merged.finishedAt; // merged is our own copy — the input stays untouched
  }
  return merged;
}

/**
 * GET /design/api/build-status handler factory (Phase 5 S2). A passive fs
 * read of /app/data/build-status.json — cheap enough for the publish strip's
 * 5s polling. Cache-Control: no-store (a build status is stale the moment
 * it's cached). NEVER 500s on an absent/corrupt file — the tolerant reader
 * maps both to unknown.
 *
 * @param {object} [options] Test seams
 * @param {() => Promise<object | null>} [options.readStatus]
 * @param {() => number} [options.now]
 * @returns {import("express").RequestHandler}
 */
export function buildStatusHandler({ readStatus = readBuildStatus, now = Date.now } = {}) {
  return async (request, response, next) => {
    try {
      response.set("Cache-Control", "no-store");
      response.json(mergeBuildStatus(await readStatus(), now()));
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Surface redirect query params as flash template vars.
 * @param {object} [query]
 * @returns {{ success?: string, error?: string, removedLabel?: string, undoUnavailable?: boolean }}
 */
export function readFlash(query = {}) {
  const flash = {};
  if (typeof query.removed === "string" && query.removed !== "") {
    flash.success = "removed";
    flash.removedLabel = query.removed;
  } else {
    for (const name of SUCCESS_FLAGS) {
      if (query[name]) {
        flash.success = name;
        break;
      }
    }
  }
  if (typeof query.error === "string" && query.error !== "") flash.error = query.error;
  if (query.noUndo) flash.undoUnavailable = true;
  if (query.sidebarMoved) flash.sidebarMoved = query.sidebarMoved;
  return flash;
}

// ---- request-time catalog helpers ----

function endpointNames(Indiekit) {
  const names = new Set();
  for (const ep of Indiekit?.endpoints || []) {
    try {
      if (typeof ep?.name === "string") names.add(ep.name);
    } catch {
      // poisoned name getter — same throw-proof posture as scan-plugins
    }
  }
  return names;
}

/** Dormant: a legacy entry whose source plugin is not currently loaded. */
function isDormant(entry, names) {
  return entry.legacy === true
    && typeof entry.sourcePlugin === "string"
    && !names.has(entry.sourcePlugin);
}

/**
 * Catalog entries for the given surface, grouped for the block picker:
 * built-in first, then plugin groups alphabetically, dormant flagged.
 * @param {object[]} catalog
 * @param {Set<string>} names Loaded endpoint names
 * @param {object} [options]
 * @param {string} [options.surfaceFilter] Value matched against each entry's
 *   `placement.surfaces[]` — an entry whose surfaces list omits it is skipped
 *   (absent surfaces = unrestricted). When the filter itself is undefined NO
 *   surface gate is applied — every entry is offered.
 * @param {string} [options.arrangement] Current arrangement — under "stack"
 *   the sidebar zone isn't rendered, so it's removed from each entry's
 *   offered regions (blocks must never be added into a hidden zone)
 * @param {string[]} [options.availableRegions] The surface's available
 *   placement regions — the VALUES of its zone-model's regionMap (homepage:
 *   [hero,main,sidebar,footer]; listing: [sidebar]). A block is placeable on
 *   this surface iff `placement.regions ∩ availableRegions ≠ ∅`. Blocks with
 *   an empty intersection are EXCLUDED (not listed at all); offered blocks have
 *   their `regions` CONSTRAINED to the intersection, so the view's Zone
 *   dropdown only offers the surface's actual zones. ABSENT ⇒ no region gate
 *   (every region of every surface-matching block is offered, as before).
 * @returns {{ group: string, blocks: object[] }[]}
 */
export function groupAvailableBlocks(catalog, names, options = {}) {
  const { arrangement, surfaceFilter, availableRegions } = options;
  // Region gate (6.3 #29): a Set of the surface's actual placement regions.
  // Undefined when the caller passes none — the gate is then skipped entirely.
  const available = Array.isArray(availableRegions) ? new Set(availableRegions) : null;
  const groups = new Map();
  for (const entry of catalog) {
    const surfaces = entry?.placement?.surfaces;
    // Absent surfaces (on the entry) = unrestricted. An absent surfaceFilter
    // (on the call) = no surface gate — never silently drop restricted blocks.
    if (surfaceFilter !== undefined && Array.isArray(surfaces) && !surfaces.includes(surfaceFilter)) {
      continue;
    }
    // Region constraint: keep only regions the surface actually has (when a
    // gate is supplied), then drop "sidebar" under "stack" (hidden zone). A
    // block with NO surviving region has nowhere to go on this surface —
    // exclude it from the picker rather than offer an unplaceable zone.
    let regions = entry.placement?.regions ?? [];
    if (available) regions = regions.filter((r) => available.has(r));
    if (arrangement === "stack") regions = regions.filter((r) => r !== "sidebar");
    if (available && regions.length === 0) continue;
    const group = entry.sourcePlugin || "built-in";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({
      id: entry.id,
      label: entry.label,
      description: entry.description || "",
      icon: entry.icon || "",
      category: entry.category || "",
      multiple: entry.multiple !== false,
      legacy: entry.legacy === true,
      dormant: isDormant(entry, names),
      regions,
    });
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "built-in" ? -1 : b === "built-in" ? 1 : a.localeCompare(b)))
    .map(([group, blocks]) => ({ group, blocks }));
}

function blockCard(node, catalogMap, names, mode, zone, arrangement, zoneModel) {
  const entry = catalogMap.get(node.type);
  return {
    id: node.id,
    type: node.type,
    label: entry?.label ?? node.type,
    icon: entry?.icon ?? "",
    category: entry?.category ?? "",
    config: node.config,
    unknown: !entry,
    legacy: entry?.legacy === true,
    dormant: entry ? isDormant(entry, names) : false,
    sourcePlugin: entry?.sourcePlugin || null,
    // Other zones this block may legally move to (the move-to select);
    // empty when the block has nowhere else to go (or is unknown). Under
    // "stack" the sidebar zone isn't rendered, so it's never offered as a
    // target — blocks must not be movable into a hidden zone.
    legalZones: entry
      ? zoneModel.zones.filter(
          (z) =>
            z !== zone &&
            !(z === "sidebar" && arrangement === "stack") &&
            placementAllows(entry, z, zoneModel.regionMap),
        )
      : [],
    fields: entry ? schemaToFields(entry.schema, { advanced: mode === "advanced" }) : [],
  };
}

// Model-driven zone traversal (D3): each helper loops `zoneModel.zones` and
// uses `Array.isArray(slot)` to distinguish a single-slot zone (homepage's
// `hero`: a node | null) from a list zone (`main`/`sidebar`/`footer`: arrays).
// For homepage this reproduces today's exact output; for any other surface it
// derives the slots from the model instead of crashing on missing keys.

/** Flatten every node across a surface's zones into a single list. */
function allZoneNodes(zones, zoneModel) {
  const nodes = [];
  for (const zone of zoneModel.zones) {
    const slot = zones[zone];
    if (Array.isArray(slot)) nodes.push(...slot);
    else if (slot) nodes.push(slot);
  }
  return nodes;
}

export function decorateZones(zones, catalog, names, mode, zoneModel) {
  const map = new Map(catalog.map((entry) => [entry.id, entry]));
  const card = (node, zone) =>
    blockCard(node, map, names, mode, zone, zones.arrangement, zoneModel);
  const result = {};
  for (const zone of zoneModel.zones) {
    const slot = zones[zone];
    result[zone] = Array.isArray(slot)
      ? slot.map((node) => card(node, zone))
      : slot
        ? card(slot, zone)
        : null;
  }
  return result;
}

export function typePresent(zones, type, zoneModel) {
  return allZoneNodes(zones, zoneModel).some((node) => node && node.type === type);
}

export function findNode(zones, blockId, zoneModel) {
  return allZoneNodes(zones, zoneModel).find((node) => node && node.id === blockId) ?? null;
}

// ---- router ----

/**
 * @param {object} Indiekit
 * @param {object} [overrides] Test seams
 * @param {(prefix: string) => string} [overrides.idFactory]
 * @param {(doc: object) => Promise<unknown>} [overrides.writeArtifact]
 *   Forwarded to publishDraft (defaults to the real artifact writer there)
 * @param {(db: object, outputDir?: string) => Promise<unknown>} [overrides.writePagesArtifact]
 *   Pages ARRAY writer (defaults to writePagesJson). Rewrites pages.json from
 *   the full published-pages set on every page publish/delete — pages do NOT
 *   use the per-doc single-file writer.
 * @param {(input: object) => Promise<unknown>} [overrides.writePreviewArtifact]
 *   Preview-draft writer (defaults to writePreviewDraft)
 * @param {() => Promise<object | null>} [overrides.readStatus]
 *   build-status.json reader (defaults to readBuildStatus)
 * @param {() => number} [overrides.now] Clock (stuck math + publish-epoch test seam)
 * @returns {import("express").Router}
 */
export function designRouter(Indiekit, overrides = {}) {
  const {
    idFactory = defaultIdFactory,
    writeArtifact,
    writePagesArtifact = writePagesJson,
    writePreviewArtifact = writePreviewDraft,
    readStatus = readBuildStatus,
    now = Date.now,
    // Surface lookup seam: defaults to the real registry. Tests inject a
    // resolver to exercise surfaces not yet registered (e.g. a no-arrangement
    // surface before the 6.3 listing entry lands).
    resolveSurfaceEntry = getSurface,
  } = overrides;
  const router = express.Router();

  const catalogOf = () => Indiekit.config?.application?.blockCatalog || [];
  const userIdent = () => Indiekit.config?.publication?.me || "unknown";

  /** HTML-route db guard: 503 text when the database is missing. */
  const requireDb = (response) => {
    const db = Indiekit.database;
    if (!db) response.status(503).send("Database not configured");
    return db;
  };

  /**
   * The editor base path for a surface (used by redirects + the view).
   * Slug-aware: a COLLECTION surface (pages) carries an injected `slug`
   * (D2), so its base path is /site-config/design/pages/<slug>; singleton
   * surfaces have no slug and keep /site-config/design/<routeKey>.
   */
  const homeOf = (surface) =>
    surface.slug
      ? `/site-config/design/${surface.routeKey}/${surface.slug}`
      : `/site-config/design/${surface.routeKey}`;

  const flashError = (response, surface, code) =>
    response.redirect(303, `${homeOf(surface)}?error=${code}`);

  /**
   * The shared POST gate: load the surface's editor state and map it to
   * zones; missing doc and custom trees are flash-rejected by every action.
   */
  async function loadEditableZones(db, surface) {
    const state = await getEditorState(db, surface.surfaceId);
    if (!state) return { error: "no-composition" };
    const zones = treeToZones(state.tree, surface.zoneModel);
    if (zones.custom) return { error: "custom-tree" };
    return { zones, state };
  }

  /** Rebuild the tree from zones and store it as the draft. */
  async function persistZones(db, surface, zones) {
    return saveDraft(db, surface.surfaceId, zonesToTree(zones, surface.zoneModel, { idFactory }));
  }

  /** Apply (zones → zones) and finish the request: save draft + flash. */
  async function applyAndSave(response, db, surface, result, successParams) {
    if (result.error) return flashError(response, surface, result.error);
    const saved = await persistZones(db, surface, result.zones);
    if (!saved.ok) return flashError(response, surface, saved.error);
    return response.redirect(303, `${homeOf(surface)}?${successParams}`);
  }

  async function editorLocals(surface, state, query, extra = {}) {
    const catalog = catalogOf();
    const names = endpointNames(Indiekit);
    const config = await getSiteConfig(Indiekit);
    const mode = config.designMode === "advanced" ? "advanced" : "simple";
    const base = {
      activeTab: "design",
      recipes: surface.recipes,
      mode,
      // Arrangement is a per-surface capability (6.3-T2): the view renders the
      // arrangement form only when the surface declares an arrangement axis.
      supportsArrangement:
        Array.isArray(surface.arrangements) && surface.arrangements.length > 0,
      // Live preview is now a per-surface capability for EVERY surface (#32):
      // the view always renders the preview pane + Structural/Preview toggle;
      // the iframe points at /preview/<previewRouteKey>/<token>/.
      // Per-surface editor copy (6.3 #28): the view renders these i18n KEYS via
      // __() instead of hardcoding "Homepage design"/its intro on every surface.
      editorTitleKey: surface.editorTitleKey,
      editorIntroKey: surface.editorIntroKey,
      // Per-surface noun (#39): the shared view interpolates this via __() into
      // {{surface}} in the confirm/draft/empty/custom/error copy, so those
      // strings read "post sidebar"/"blog listing" instead of "homepage".
      editorNounKey: surface.editorNounKey,
      // T4 will use this to parameterize the view's form-action paths; for
      // homepage routeKey === "homepage" so today's hardcoded paths still match.
      surfaceBase: homeOf(surface),
      // The surface's zone vocabulary (6.3-T4): the view renders ONLY the zones
      // the zone-model declares (homepage: hero/main/sidebar/footer; listing:
      // sidebar). Gating each zone's markup on membership lets the shared view
      // degrade to a sidebar-only editor without empty hero/main/footer zones.
      zoneNames: surface.zoneModel.zones,
      ...readFlash(query),
    };
    if (!state) return { ...base, noComposition: true };
    const zones = treeToZones(state.tree, surface.zoneModel);
    // Custom-tree preview scope (deliberate, Phase 5): the preview POST
    // accepts custom trees (they render fine through the production
    // renderer), but this read-only view offers NO preview pane affordance —
    // the editor is read-only for custom trees, full stop. Hand-built trees
    // are previewed by their authors out-of-band.
    if (zones.custom) return { ...base, customTree: true, isDraft: state.isDraft };
    const token = typeof query.u === "string" ? query.u : null;
    const undo = token ? parseUndoPayload(token, surface.zoneModel.zones) : null;
    // Right-pane mode is server state (?pane=preview) so the toggle works
    // without JS by full reload; structural stays the default.
    const pane = query.pane === "preview" ? "preview" : "structural";
    const preview = Indiekit.database
      ? await getPreviewState(Indiekit.database, surface.routeKey)
      : { token: null, revision: 0 };
    return {
      ...base,
      zones,
      blocks: decorateZones(zones, catalog, names, mode, surface.zoneModel),
      availableBlocks: groupAvailableBlocks(catalog, names, {
        arrangement: zones.arrangement,
        surfaceFilter: surface.surfaceFilter,
        // 6.3 #29: the surface's available placement regions = the VALUES of
        // its zone-model's regionMap (homepage: [hero,main,sidebar,footer];
        // listing: [sidebar]). Excludes blocks with no placeable zone here and
        // constrains each offered block's Zone dropdown to the surface's zones.
        availableRegions: Object.values(surface.zoneModel.regionMap),
      }),
      isDraft: state.isDraft,
      draftUpdatedAt: state.doc.draftUpdatedAt ?? null,
      undo: undo ? { ...undo, token } : null,
      pane,
      preview,
      // Per-surface preview URL key (#32-T3, D6): the view builds the iframe
      // src as /preview/<routeKey>/<token>/ — passing the routeKey here lets the
      // shared view disambiguate the surface's own preview slot. T6 wires the
      // view to it; the theme (T5) emits the /preview/<routeKey>/<token>/ page.
      previewRouteKey: surface.routeKey,
      previewing: typeof query.previewing === "string" ? query.previewing : null,
      ...extra,
    };
  }

  // Slug shape gate (D2): the routing-level shape filter so a malformed slug
  // 404s instead of minting a "page:<garbage>" surfaceId. This is NOT the
  // authoritative guard — the FULL double-guard (anchored shape + reserved
  // prefixes + collision legs) runs at CREATE/save time (validators/
  // page-route.js, called by T3). Both legs share ONE anchored regex
  // (PAGE_SLUG, imported above) so the routing gate and the save-time guard
  // can never drift apart. A request that slips past this routing gate still
  // hits the save-time guard (and, on publish, the composition validator's
  // independent target.route check) — three layers, defense in depth.

  /**
   * Pages-collection injector (D2): the pages sub-router mounts at
   * /pages/:slug, so the slug is captured BEFORE the shared `surface`
   * sub-router runs. This middleware clones the frozen `pages` entry, sets the
   * request-derived `surfaceId = "page:" + slug` and the `slug` (for
   * slug-aware homeOf), and attaches it to request.surface. The clone is
   * shallow — the frozen registry entry is NEVER mutated. Then the shared
   * `surface` router's handlers run UNCHANGED (they read entry.surfaceId).
   */
  function injectPageSurface(request, response, next) {
    const slug = request.params.slug;
    if (typeof slug !== "string" || !PAGE_SLUG.test(slug)) {
      return response.status(404).send("Invalid page slug");
    }
    const entry = resolveSurfaceEntry("pages");
    if (!entry) return response.status(404).send("Unknown design surface");
    // Per-request CLONE — never mutate the frozen registry entry.
    request.surface = { ...entry, surfaceId: `page:${slug}`, slug };
    next();
  }

  /**
   * Resolver middleware: 404 unknown surfaces, attach the entry. Skips
   * re-resolution when a surface is already injected (the pages sub-router
   * pre-injects a per-slug clone via injectPageSurface) — so the shared
   * handlers run identically for singletons and pages.
   */
  function resolveSurface(request, response, next) {
    if (request.surface) return next();
    const entry = resolveSurfaceEntry(request.params.surface);
    if (!entry) return response.status(404).send("Unknown design surface");
    // A COLLECTION surface has no static surfaceId — it must be reached via its
    // slug-scoped sub-router (/pages/:slug), never the bare /:surface route.
    if (entry.isCollection) return response.status(404).send("Unknown design surface");
    request.surface = entry;
    next();
  }

  // -- hub (top-level: not surface-scoped) --

  router.get("/", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      // One card per hub key in display order. Keys present in the registry
      // (homepage, listing) render as LIVE cards carrying draft/updatedAt
      // metadata from their compositions doc; keys not yet registered (posttype,
      // pages) render as disabled placeholders until their phase lands.
      const compositions = db.collection("compositions");
      const surfaces = [];
      for (const key of HUB_CARD_ORDER) {
        const entry = getSurface(key);
        if (!entry) {
          surfaces.push({ key, enabled: false });
          continue;
        }
        // COLLECTION surfaces (pages) have no single surfaceId to look up — the
        // proper "N pages + New page" card is 6.5-T5. Until then the hub renders
        // them as a disabled placeholder (the singleton card model can't
        // represent a collection). This keeps the existing hub behavior intact.
        if (entry.isCollection) {
          surfaces.push({ key: entry.hubKey, enabled: false });
          continue;
        }
        const doc = await compositions.findOne({ _id: entry.surfaceId });
        surfaces.push({
          key: entry.hubKey,
          href: `/site-config/design/${entry.routeKey}`,
          enabled: true,
          exists: Boolean(doc),
          hasDraft: Boolean(doc?.draftTree),
          updatedAt: doc?.updatedAt ?? null,
        });
      }
      response.render(HUB_VIEW, { activeTab: "design", surfaces });
    } catch (error) {
      next(error);
    }
  });

  // -- build-status API (Phase 5 S2; top-level, not surface-scoped) --
  // Authed (the whole design router mounts behind the session gate);
  // polled every 5s by the publish strip in editor.js.
  router.get("/api/build-status", buildStatusHandler({ readStatus, now }));

  // -- mode toggle (top-level: site-wide designMode, not surface-scoped) --
  router.post("/mode", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      // mode is site-wide (not surface-scoped); its toggle form lives on the
      // homepage editor, so errors/redirects land there by convention.
      const homeEntry = getSurface("homepage");
      const mode = request.body?.mode;
      if (mode !== "simple" && mode !== "advanced") {
        return flashError(response, homeEntry, "invalid-mode");
      }
      await saveSiteConfig(Indiekit, { designMode: mode }, userIdent());
      response.redirect(303, homeOf(homeEntry));
    } catch (error) {
      next(error);
    }
  });

  // -- per-surface editor sub-router --
  // Registered LAST so the `:surface` param can never shadow the top-level
  // `/`, `/api/build-status`, or `/mode` routes above. resolveSurface 404s
  // unknown/not-yet-live surfaces and attaches request.surface.
  const surface = express.Router({ mergeParams: true });
  surface.use(resolveSurface);

  surface.get("/", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const { surface: entry } = request;
      const state = await getEditorState(db, entry.surfaceId);
      const query = request.query ?? {};
      // No-JS publish flow: ?published=<epoch> (any truthy value — legacy
      // ?published=1 links still work) renders the LAST-KNOWN build status
      // server-side (same tolerant reader as the API) with a reload-to-update
      // note; editor.js replaces it with epoch-aware 5s polling.
      const extra = query.published
        ? { buildStatus: mergeBuildStatus(await readStatus(), now()) }
        : {};
      response.render(entry.editorView, await editorLocals(entry, state, query, extra));
    } catch (error) {
      next(error);
    }
  });

  surface.post("/blocks/add", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const { surface: entry } = request;
      const parsed = parseAddBody(request.body ?? {}, entry.zoneModel.zones);
      if (parsed.error) return flashError(response, entry, parsed.error);
      const loaded = await loadEditableZones(db, entry);
      if (loaded.error) return flashError(response, entry, loaded.error);
      // Hidden-zone gate: under "stack" the sidebar zone isn't rendered, so
      // adding into it would make the block vanish from the editor.
      if (parsed.zone === "sidebar" && loaded.zones.arrangement === "stack") {
        return flashError(response, entry, "invalid-zone");
      }
      const blockEntry = catalogOf().find((e) => e.id === parsed.type);
      if (!blockEntry) return flashError(response, entry, "unknown-type");
      if (!placementAllows(blockEntry, parsed.zone, entry.zoneModel.regionMap)) {
        return flashError(response, entry, "placement");
      }
      // multiple:false is the controller's gate — block-ops is catalog-free.
      if (blockEntry.multiple === false && typePresent(loaded.zones, parsed.type, entry.zoneModel)) {
        return flashError(response, entry, "duplicate");
      }
      const config = blockEntry.defaultConfig ? structuredClone(blockEntry.defaultConfig) : {};
      const result = addBlock(loaded.zones, { zone: parsed.zone, type: parsed.type, config, idFactory });
      return await applyAndSave(response, db, entry, result, "added=1");
    } catch (error) {
      next(error);
    }
  });

  const moveHandler = (direction) => async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const { surface: entry } = request;
      const loaded = await loadEditableZones(db, entry);
      if (loaded.error) return flashError(response, entry, loaded.error);
      const result = moveBlock(loaded.zones, { blockId: request.params.blockId, direction });
      return await applyAndSave(response, db, entry, result, "moved=1");
    } catch (error) {
      next(error);
    }
  };
  surface.post("/blocks/:blockId/move-up", moveHandler("up"));
  surface.post("/blocks/:blockId/move-down", moveHandler("down"));

  surface.post("/blocks/:blockId/move-to", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const { surface: entry } = request;
      const zone = parseZone(request.body?.zone, entry.zoneModel.zones);
      if (!zone) return flashError(response, entry, "invalid-zone");
      const loaded = await loadEditableZones(db, entry);
      if (loaded.error) return flashError(response, entry, loaded.error);
      const { blockId } = request.params;
      const node = findNode(loaded.zones, blockId, entry.zoneModel);
      if (!node) return flashError(response, entry, "not-found");
      // Hidden-zone gate (mirrors add): under "stack" the sidebar zone isn't
      // rendered, so moving into it would make the block vanish.
      if (zone === "sidebar" && loaded.zones.arrangement === "stack") {
        return flashError(response, entry, "invalid-zone");
      }
      const blockEntry = catalogOf().find((e) => e.id === node.type);
      if (!placementAllows(blockEntry, zone, entry.zoneModel.regionMap)) {
        return flashError(response, entry, "placement");
      }
      const result = moveBlockToZone(loaded.zones, { blockId, zone });
      return await applyAndSave(response, db, entry, result, "moved=1");
    } catch (error) {
      next(error);
    }
  });

  // Drag-end target (D4 enhancement); the no-JS path uses move-up/down.
  surface.post("/blocks/:blockId/move-to-index", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const { surface: entry } = request;
      const zone = parseZone(request.body?.zone, entry.zoneModel.zones);
      if (!zone) return flashError(response, entry, "invalid-zone");
      const index = Number.parseInt(request.body?.index, 10);
      if (Number.isNaN(index)) return flashError(response, entry, "invalid-index");
      const loaded = await loadEditableZones(db, entry);
      if (loaded.error) return flashError(response, entry, loaded.error);
      const { blockId } = request.params;
      const node = findNode(loaded.zones, blockId, entry.zoneModel);
      if (!node) return flashError(response, entry, "not-found");
      // Hidden-zone gate (mirrors add): under "stack" the sidebar zone isn't
      // rendered, so dropping into it would make the block vanish.
      if (zone === "sidebar" && loaded.zones.arrangement === "stack") {
        return flashError(response, entry, "invalid-zone");
      }
      const blockEntry = catalogOf().find((e) => e.id === node.type);
      if (!placementAllows(blockEntry, zone, entry.zoneModel.regionMap)) {
        return flashError(response, entry, "placement");
      }
      // remove + index-clamped restore = positional move, reusing the
      // immutable ops instead of inventing a third splice path.
      const removed = removeBlock(loaded.zones, { blockId });
      if (removed.error) return flashError(response, entry, removed.error);
      const result = restoreBlock(removed.zones, { node: removed.removed.node, zone, index });
      return await applyAndSave(response, db, entry, result, "moved=1");
    } catch (error) {
      next(error);
    }
  });

  surface.post("/blocks/:blockId/remove", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const { surface: entry } = request;
      const loaded = await loadEditableZones(db, entry);
      if (loaded.error) return flashError(response, entry, loaded.error);
      const result = removeBlock(loaded.zones, { blockId: request.params.blockId });
      if (result.error) return flashError(response, entry, result.error);
      const saved = await persistZones(db, entry, result.zones);
      if (!saved.ok) return flashError(response, entry, saved.error);
      const blockEntry = catalogOf().find((e) => e.id === result.removed.node.type);
      const params = new URLSearchParams({ removed: blockEntry?.label ?? result.removed.node.type });
      const token = encodeUndoPayload(result.removed);
      if (token) params.set("u", token);
      else params.set("noUndo", "1"); // oversized payload — removal stands, undo unavailable
      response.redirect(303, `${homeOf(entry)}?${params}`);
    } catch (error) {
      next(error);
    }
  });

  surface.post("/blocks/restore", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const { surface: entry } = request;
      const payload = parseUndoPayload(request.body?.u, entry.zoneModel.zones);
      if (!payload) return flashError(response, entry, "undo-invalid");
      const loaded = await loadEditableZones(db, entry);
      if (loaded.error) return flashError(response, entry, loaded.error);
      // Hidden-zone gate (mirrors add): a token minted before an arrangement
      // switch to "stack" could restore into the hidden sidebar zone — the
      // block would silently vanish from the editor.
      if (payload.zone === "sidebar" && loaded.zones.arrangement === "stack") {
        return flashError(response, entry, "invalid-zone");
      }
      // STRICT semantic gate — the token is client-held state. Worst case
      // after this gate: a valid block of a known type re-appears.
      const blockEntry = catalogOf().find((e) => e.id === payload.node.type);
      if (!blockEntry) return flashError(response, entry, "unknown-type");
      if (!placementAllows(blockEntry, payload.zone, entry.zoneModel.regionMap)) {
        return flashError(response, entry, "placement");
      }
      const configCheck = validateConfigAgainstSchema(payload.node.config ?? {}, blockEntry.schema);
      if (!configCheck.ok) return flashError(response, entry, "undo-invalid");
      if (blockEntry.multiple === false && typePresent(loaded.zones, payload.node.type, entry.zoneModel)) {
        return flashError(response, entry, "duplicate");
      }
      if (findNode(loaded.zones, payload.node.id, entry.zoneModel)) {
        return flashError(response, entry, "duplicate");
      }
      // Sanitize custom-html content on restore — the undo token is
      // client-held state and the theme renders the content `| safe`.
      const restoredConfig = { ...(payload.node.config ?? {}) };
      if (payload.node.type === "custom-html" && typeof restoredConfig.content === "string") {
        restoredConfig.content = sanitizeCustomHtml(restoredConfig.content);
      }
      // Rebuild from validated parts (extra payload keys dropped); the
      // validated (custom-html: sanitized) config is persisted.
      const node = {
        block: "section",
        id: payload.node.id,
        type: payload.node.type,
        v: blockEntry.version ?? 0, // catalog-authoritative — never the payload's
        config: restoredConfig,
      };
      const result = restoreBlock(loaded.zones, { node, zone: payload.zone, index: payload.index });
      return await applyAndSave(response, db, entry, result, "restored=1");
    } catch (error) {
      next(error);
    }
  });

  surface.post("/blocks/:blockId/config", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const { surface: entry } = request;
      const loaded = await loadEditableZones(db, entry);
      if (loaded.error) return flashError(response, entry, loaded.error);
      const { blockId } = request.params;
      const node = findNode(loaded.zones, blockId, entry.zoneModel);
      if (!node) return flashError(response, entry, "not-found");
      const blockEntry = catalogOf().find((e) => e.id === node.type);
      if (!blockEntry) return flashError(response, entry, "unknown-type");
      const parsed = parseConfigBody(request.body ?? {}, blockEntry.schema);
      if (!parsed.ok) {
        // Re-render (200) with the block's panel open and field errors —
        // redirecting would lose the user's input context.
        const locals = await editorLocals(entry, loaded.state, {}, {
          fieldErrors: parsed.errors,
          openBlockId: blockId,
          submittedConfig: parsed.config, // re-fill the form with what was typed
        });
        return response.status(200).render(entry.editorView, locals);
      }
      // Sanitize custom-html content at WRITE time — the theme renders it
      // `| safe`, and the retired v3 save path ran the same control
      // (sanitizeEntries in controllers/homepage.js). Schema validation has
      // already passed; sanitization only ever narrows the value.
      const config =
        node.type === "custom-html" && typeof parsed.config.content === "string"
          ? { ...parsed.config, content: sanitizeCustomHtml(parsed.config.content) }
          : parsed.config;
      const result = updateBlockConfig(loaded.zones, { blockId, config });
      return await applyAndSave(response, db, entry, result, "saved=1");
    } catch (error) {
      next(error);
    }
  });

  // ARRANGEMENT is a per-surface CAPABILITY (6.3-T2). A surface declares its
  // valid arrangement values via `entry.arrangements` (homepage:
  // ["stack","sidebar-right"]); a surface that omits the field has NO
  // arrangement axis (e.g. the sidebar-only listing surface) and this route
  // 404s for it — gated BEFORE any zone access, because the sidebar→main
  // collapse below spreads `zones.main`, which a sidebar-only surface lacks.
  surface.post("/arrangement", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const { surface: entry } = request;
      // Capability gate: no arrangement axis ⇒ route does not exist here.
      // MUST precede zone access (loaded.zones.main is undefined for
      // sidebar-only surfaces).
      if (!Array.isArray(entry.arrangements) || entry.arrangements.length === 0) {
        return response.status(404).send("No arrangement for this surface");
      }
      const arrangement = request.body?.arrangement;
      if (!entry.arrangements.includes(arrangement)) {
        return flashError(response, entry, "invalid-arrangement");
      }
      const loaded = await loadEditableZones(db, entry);
      if (loaded.error) return flashError(response, entry, loaded.error);
      let zones = { ...loaded.zones, arrangement };
      let sidebarMoved = 0;
      if (arrangement === "stack" && loaded.zones.sidebar.length > 0) {
        // Never silently drop sidebar blocks — append them to main and say so.
        sidebarMoved = loaded.zones.sidebar.length;
        zones = { ...zones, main: [...loaded.zones.main, ...loaded.zones.sidebar], sidebar: [] };
      }
      const params = new URLSearchParams({ arranged: "1" });
      if (sidebarMoved > 0) params.set("sidebarMoved", String(sidebarMoved));
      return await applyAndSave(response, db, entry, { zones }, params);
    } catch (error) {
      next(error);
    }
  });

  surface.post("/apply-recipe", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const { surface: entry } = request;
      // A surface with no recipes can't apply one.
      if (!Array.isArray(entry.recipes) || entry.recipes.length === 0) {
        return response.status(404).send("No recipes for this surface");
      }
      const preset = entry.recipes.find((p) => p.id === request.body?.recipeId);
      if (!preset) return flashError(response, entry, "unknown-recipe");
      const state = await getEditorState(db, entry.surfaceId);
      if (state && treeToZones(state.tree, entry.zoneModel).custom) {
        return flashError(response, entry, "custom-tree"); // read-only means read-only
      }
      const tree = entry.treeBuilder(preset, idFactory);
      if (state) await saveDraft(db, entry.surfaceId, tree);
      else await createDraftFromTree(db, entry.surfaceId, entry.kind, tree);
      response.redirect(303, `${homeOf(entry)}?recipe=1`);
    } catch (error) {
      next(error);
    }
  });

  // On-demand preview-draft write (Phase 5). NOTE: custom trees ARE allowed
  // here — a custom tree renders through the same PRODUCTION renderer at
  // /preview/<token>/; only the EDITOR (block ops) is read-only for custom
  // trees. The artifact is written ONLY on this explicit POST and on publish
  // (every write triggers an incremental Eleventy rebuild — ~25s on large
  // sites), never per keystroke.
  surface.post("/preview", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const { surface: entry } = request;
      // Per-surface preview slot (#32-T3, D3): every surface previews now. Each
      // surface owns an ISOLATED slot keyed by routeKey — preview-state fns and
      // the artifact writer take entry.routeKey, so a listing/posttype preview
      // writes previews.<routeKey> + preview-<routeKey>.json and can NEVER touch
      // the homepage slot. (The shared-slot clobber risk that motivated the old
      // supportsLivePreview 404 gate is gone now that slots are per-surface.)
      // NOTE: composition reads stay keyed by surfaceId; preview state + the
      // artifact are keyed by routeKey.
      const state = await getEditorState(db, entry.surfaceId);
      // state.tree = draftTree ?? published tree; a doc with neither (never
      // seeded, draft discarded) has nothing to preview.
      if (!state?.tree) return flashError(response, entry, "no-composition");
      const token = await ensureToken(db, entry.routeKey);
      const revision = await bumpRevision(db, entry.routeKey);
      await writePreviewArtifact({ surface: entry.routeKey, tree: state.tree, revision, token });
      // Dual response (plain-POST-first): editor.js fetches with
      // Accept: application/json; the no-JS form post gets the standard
      // redirect and the GET locals carry token/revision.
      if ((request.headers?.accept ?? "").includes("application/json")) {
        const status = await readStatus();
        const expectedSeconds =
          typeof status?.lastOkDurationSeconds === "number"
            ? status.lastOkDurationSeconds
            : null;
        return response.json({ token, revision, expectedSeconds });
      }
      return response.redirect(303, `${homeOf(entry)}?pane=preview&previewing=${revision}`);
    } catch (error) {
      next(error);
    }
  });

  surface.post("/publish", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const { surface: entry } = request;
      // Pages render from the SINGLE pages.json ARRAY artifact, NOT a per-page
      // single file. publishDraft's writeArtifact is doc-shaped (one file per
      // surface), so for a page we suppress it (inject a no-op) and rewrite the
      // whole published-pages array below instead. Singletons keep the per-doc
      // writer (the real one, or the test seam) exactly as before.
      const isPage = entry.kind === "page";
      const result = await publishDraft(db, entry.surfaceId, catalogOf(), {
        ...(isPage ? { writeArtifact: async () => {} } : writeArtifact ? { writeArtifact } : {}),
        updatedBy: userIdent(),
      });
      if (result.ok) {
        if (isPage) {
          // Re-find ALL published pages and rewrite pages.json in one atomic
          // array write. A rewrite failure must not turn a successful publish
          // (db promotion already done) into an error page — warn and proceed
          // (boot self-heals the artifact on the next start).
          try {
            await writePagesArtifact(db);
          } catch (error) {
            console.warn(
              "[site-config] pages.json rewrite after publish failed:",
              error?.message ?? String(error),
            );
          }
        }
        // Per-publish, per-surface token rotation (spec §5.3; #32-T3, D3):
        // each surface rotates its OWN per-surface slot — previously issued
        // preview URLs for THIS surface expire (its old /preview/<routeKey>/
        // <token>/ page dies on the next rebuild, intentionally). A FRESH
        // preview-draft is written from the now-published tree so the surface's
        // preview pane tracks the NEW token immediately. Every surface runs this
        // now (no shared-slot gate): preview state + the artifact are keyed by
        // entry.routeKey, so rotating one surface can never touch another's slot
        // — the per-surface isolation makes the old single-owner gate obsolete.
        // The composition read stays keyed by surfaceId. The publish itself
        // already succeeded (db promotion + artifact) — a preview refresh
        // failure must never turn it into an error page, so this block warns.
        try {
          const token = await rotateToken(db, entry.routeKey);
          const revision = await bumpRevision(db, entry.routeKey);
          const published = await db.collection("compositions").findOne({ _id: entry.surfaceId });
          if (published?.tree) {
            await writePreviewArtifact({ surface: entry.routeKey, tree: published.tree, revision, token });
          }
        } catch (error) {
          console.warn(
            "[site-config] preview rotation after publish failed:",
            error?.message ?? String(error),
          );
        }
        // The flash value is the publish epoch (ms, SERVER clock — the same
        // clock that writes finishedAt into build-status.json). editor.js
        // compares finishedAt against it so a stale pre-publish "ok" is
        // never mistaken for the new build landing. Server-side the value
        // is only ever truthiness-checked (readFlash / the no-JS strip
        // gate) and never rendered.
        return response.redirect(303, `${homeOf(entry)}?published=${now()}`);
      }
      if (result.error === "not-found") return flashError(response, entry, "no-composition");
      if (result.error === "conflict") return flashError(response, entry, "conflict");
      // The flash only says "failed validation" — log the actual validator
      // errors so a rejected publish is diagnosable from the server logs.
      console.warn("[site-config] publish rejected:", result.errors.join(" | "));
      return flashError(response, entry, "publish-invalid");
    } catch (error) {
      next(error);
    }
  });

  surface.post("/discard", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const { surface: entry } = request;
      await discardDraft(db, entry.surfaceId);
      response.redirect(303, `${homeOf(entry)}?discarded=1`);
    } catch (error) {
      next(error);
    }
  });

  // -- pages collection: create / delete (top-level, NOT surface-scoped) --
  // These live ABOVE the /pages/:slug and /:surface mounts so they take
  // precedence: POST /pages (create, no slug) and POST /pages/:slug/delete
  // (a dedicated collection op, not one of the shared per-surface editor
  // handlers). The shared surface sub-router has no create/delete handler —
  // a page is born here and unpublished here.

  // CREATE (D2): body {route|slug, title} → guardPageRoute (shape + reserved +
  // collision) → createPage (atomic create-only) → redirect to the editor.
  // Every reject (bad shape, reserved, collision, create-race exists) becomes
  // a CLEAR flash error on the pages hub, NEVER a 500.
  router.post("/pages", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const pages = getSurface("pages");
      // The route/slug field (accept either name); title is required by the guard.
      const input = request.body?.route ?? request.body?.slug;
      const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
      // Hub-level flash: the create form lives on the pages hub card (T5), so a
      // reject redirects back to /site-config/design/pages?error=<code>.
      const hubError = (code) =>
        response.redirect(303, `/site-config/design/pages?error=${code}`);

      // Title is required up front (the guard validates the route; the page doc
      // needs a title too). An empty title is a bad-request flash, not a 500.
      if (title === "") return hubError("page-title-required");

      const guard = await guardPageRoute(input, { db, Indiekit });
      if (!guard.ok) {
        // Map the guard's failure to a stable flash code. The guard's prose
        // error is logged; the operator sees a category.
        const code = /reserved/i.test(guard.error)
          ? "reserved-route"
          : /collid|exist|already|taken/i.test(guard.error)
            ? "route-taken"
            : /verify/i.test(guard.error)
              ? "route-unverifiable"
              : "invalid-route";
        return hubError(code);
      }

      // Starter draft tree — an empty full-page composition (root container with
      // an empty main stack), the same builder the homepage recipes seed from.
      const tree = pages.treeBuilder({}, idFactory);
      const created = await createPage(
        db,
        guard.slug,
        { route: guard.route, title },
        tree,
      );
      // Atomicity backstop (D5 LOW): the create-only insert lost a race (the
      // doc landed between the collision check and the insert). Surface a
      // conflict flash — never a 500.
      if (!created.ok) return hubError("route-taken");

      return response.redirect(303, `/site-config/design/pages/${guard.slug}?created=1`);
    } catch (error) {
      next(error);
    }
  });

  // DELETE / UNPUBLISH (D2): remove the page:<slug> composition doc so it
  // leaves the published set. The slug shape is gated by injectPageSurface
  // (a malformed slug 404s before any delete). Graceful on a missing doc.
  //
  // Unpublishing a page (delete) removes it from the published set, so the
  // pages.json ARRAY must be rewritten WITHOUT it. The doc is removed first,
  // then writePagesArtifact re-reads the remaining published pages and rewrites
  // the array atomically. NO .md is generated.
  router.post("/pages/:slug/delete", injectPageSurface, async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const { surface } = request; // injected clone carries surfaceId=page:<slug>
      await deleteComposition(db, surface.surfaceId);
      // Rewrite pages.json without the removed page. A rewrite failure must not
      // turn a successful delete into an error page — warn and proceed (boot
      // self-heals the artifact on the next start).
      try {
        await writePagesArtifact(db);
      } catch (error) {
        console.warn(
          "[site-config] pages.json rewrite after delete failed:",
          error?.message ?? String(error),
        );
      }
      return response.redirect(303, "/site-config/design/pages?deleted=1");
    } catch (error) {
      next(error);
    }
  });

  // Pages collection (6.5, D2): mounted BEFORE the generic /:surface so
  // "/pages/about" + "/pages/about/blocks/add" route here (the slug is
  // consumed by this mount; the remaining path runs the SHARED surface
  // handlers). injectPageSurface pre-sets request.surface to a per-slug clone;
  // the shared router's resolveSurface then short-circuits. Mounting /pages
  // ahead of /:surface also stops ":surface" from ever capturing "pages" with
  // a real slug, and keeps the singleton routes byte-behavior-unchanged.
  router.use("/pages/:slug", injectPageSurface, surface);

  router.use("/:surface", surface);

  return router;
}
