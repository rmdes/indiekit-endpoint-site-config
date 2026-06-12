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
} from "../storage/composition-draft.js";
import { buildHomepageTree } from "../storage/migrate-v3-to-v4.js";
import { treeToZones, zonesToTree } from "../editor/zones.js";
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
import { LAYOUT_PRESETS } from "../presets/layout-presets.js";

const HOME = "/site-config/design/homepage";
const HUB_VIEW = "site-config-design";
const EDITOR_VIEW = "site-config-design-homepage";
const SURFACE_ID = "homepage";

const ZONE_TO_REGION = Object.freeze({
  hero: "hero",
  main: "main",
  sidebar: "sidebar",
  footer: "footer",
});
const ZONES = new Set(Object.keys(ZONE_TO_REGION));

// Undo tokens ride in URLs — bound them hard (a typical removed block is a
// few hundred chars; 4k+ means someone is stuffing the query string).
const MAX_UNDO_CHARS = 4096;

const SUCCESS_FLAGS = ["saved", "added", "moved", "restored", "recipe", "published", "discarded", "arranged"];

const defaultIdFactory = (prefix) => `${prefix}_${randomBytes(3).toString("hex")}`;

// ---- pure seams (exported for direct unit testing) ----

/** @param {unknown} value @returns {string | null} A valid editor zone or null */
export function parseZone(value) {
  return ZONES.has(value) ? value : null;
}

/**
 * @param {unknown} body
 * @returns {{ zone: string, type: string } | { error: string }}
 */
export function parseAddBody(body) {
  const zone = parseZone(body?.zone);
  if (!zone) return { error: "invalid-zone" };
  const type = typeof body?.type === "string" && body.type !== "" ? body.type : null;
  if (!type) return { error: "unknown-type" };
  return { zone, type };
}

/**
 * Catalog gate: may a block of this entry live in this editor zone?
 * @param {object | undefined} entry Catalog entry
 * @param {string} zone Editor zone (already parseZone-validated)
 * @returns {boolean}
 */
export function placementAllows(entry, zone) {
  const regions = entry?.placement?.regions;
  return Array.isArray(regions) && regions.includes(ZONE_TO_REGION[zone]);
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
 * @returns {{ node: object, zone: string, index: number } | null}
 */
export function parseUndoPayload(raw) {
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
    if (!parseZone(zone)) return null;
    if (!Number.isInteger(index)) return null;
    return { node, zone, index };
  } catch {
    return null;
  }
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
 * Homepage-surface catalog entries grouped for the block picker:
 * built-in first, then plugin groups alphabetically, dormant flagged.
 * @param {object[]} catalog
 * @param {Set<string>} names Loaded endpoint names
 * @returns {{ group: string, blocks: object[] }[]}
 */
export function groupAvailableBlocks(catalog, names) {
  const groups = new Map();
  for (const entry of catalog) {
    const surfaces = entry?.placement?.surfaces;
    // Absent surfaces = unrestricted (the contract allows omitting them).
    if (Array.isArray(surfaces) && !surfaces.includes("homepage")) continue;
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
      regions: entry.placement?.regions ?? [],
    });
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "built-in" ? -1 : b === "built-in" ? 1 : a.localeCompare(b)))
    .map(([group, blocks]) => ({ group, blocks }));
}

function blockCard(node, catalogMap, names, mode) {
  const entry = catalogMap.get(node.type);
  return {
    id: node.id,
    type: node.type,
    label: entry?.label ?? node.type,
    icon: entry?.icon ?? "",
    config: node.config,
    unknown: !entry,
    legacy: entry?.legacy === true,
    dormant: entry ? isDormant(entry, names) : false,
    fields: entry ? schemaToFields(entry.schema, { advanced: mode === "advanced" }) : [],
  };
}

function decorateZones(zones, catalog, names, mode) {
  const map = new Map(catalog.map((entry) => [entry.id, entry]));
  return {
    hero: zones.hero ? blockCard(zones.hero, map, names, mode) : null,
    main: zones.main.map((node) => blockCard(node, map, names, mode)),
    sidebar: zones.sidebar.map((node) => blockCard(node, map, names, mode)),
    footer: zones.footer.map((node) => blockCard(node, map, names, mode)),
  };
}

function typePresent(zones, type) {
  return [zones.hero, ...zones.main, ...zones.sidebar, ...zones.footer]
    .some((node) => node && node.type === type);
}

function findNode(zones, blockId) {
  if (zones.hero?.id === blockId) return zones.hero;
  return (
    [...zones.main, ...zones.sidebar, ...zones.footer].find((node) => node.id === blockId) ?? null
  );
}

// ---- router ----

/**
 * @param {object} Indiekit
 * @param {object} [overrides] Test seams
 * @param {(prefix: string) => string} [overrides.idFactory]
 * @param {(doc: object) => Promise<unknown>} [overrides.writeArtifact]
 *   Forwarded to publishDraft (defaults to the real artifact writer there)
 * @returns {import("express").Router}
 */
export function designRouter(Indiekit, overrides = {}) {
  const { idFactory = defaultIdFactory, writeArtifact } = overrides;
  const router = express.Router();

  const catalogOf = () => Indiekit.config?.application?.blockCatalog || [];
  const userIdent = () => Indiekit.config?.publication?.me || "unknown";

  /** HTML-route db guard: 503 text when the database is missing. */
  const requireDb = (response) => {
    const db = Indiekit.database;
    if (!db) response.status(503).send("Database not configured");
    return db;
  };

  const flashError = (response, code) => response.redirect(303, `${HOME}?error=${code}`);

  /**
   * The shared POST gate: load the homepage editor state and map it to
   * zones; missing doc and custom trees are flash-rejected by every action.
   */
  async function loadEditableZones(db) {
    const state = await getEditorState(db, SURFACE_ID);
    if (!state) return { error: "no-composition" };
    const zones = treeToZones(state.tree);
    if (zones.custom) return { error: "custom-tree" };
    return { zones, state };
  }

  /** Rebuild the tree from zones and store it as the draft. */
  async function persistZones(db, zones) {
    return saveDraft(db, SURFACE_ID, zonesToTree(zones, { idFactory }));
  }

  /** Apply (zones → zones) and finish the request: save draft + flash. */
  async function applyAndSave(response, db, result, successParams) {
    if (result.error) return flashError(response, result.error);
    const saved = await persistZones(db, result.zones);
    if (!saved.ok) return flashError(response, saved.error);
    return response.redirect(303, `${HOME}?${successParams}`);
  }

  async function editorLocals(state, query, extra = {}) {
    const catalog = catalogOf();
    const names = endpointNames(Indiekit);
    const config = await getSiteConfig(Indiekit);
    const mode = config.designMode === "advanced" ? "advanced" : "simple";
    const base = {
      activeTab: "design",
      recipes: LAYOUT_PRESETS,
      mode,
      ...readFlash(query),
    };
    if (!state) return { ...base, noComposition: true };
    const zones = treeToZones(state.tree);
    if (zones.custom) return { ...base, customTree: true, isDraft: state.isDraft };
    const token = typeof query.u === "string" ? query.u : null;
    const undo = token ? parseUndoPayload(token) : null;
    return {
      ...base,
      zones,
      blocks: decorateZones(zones, catalog, names, mode),
      availableBlocks: groupAvailableBlocks(catalog, names),
      isDraft: state.isDraft,
      draftUpdatedAt: state.doc.draftUpdatedAt ?? null,
      undo: undo ? { ...undo, token } : null,
      ...extra,
    };
  }

  // -- hub --

  router.get("/", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const doc = await db.collection("compositions").findOne({ _id: SURFACE_ID });
      const surfaces = [
        {
          key: "homepage",
          href: HOME,
          enabled: true,
          exists: Boolean(doc),
          hasDraft: Boolean(doc?.draftTree),
          updatedAt: doc?.updatedAt ?? null,
        },
        // Phase 6 surfaces — visible but disabled cards.
        { key: "listing", enabled: false },
        { key: "posttype", enabled: false },
        { key: "pages", enabled: false },
      ];
      response.render(HUB_VIEW, { activeTab: "design", surfaces });
    } catch (error) {
      next(error);
    }
  });

  // -- editor --

  router.get("/homepage", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const state = await getEditorState(db, SURFACE_ID);
      response.render(EDITOR_VIEW, await editorLocals(state, request.query ?? {}));
    } catch (error) {
      next(error);
    }
  });

  router.post("/homepage/blocks/add", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const parsed = parseAddBody(request.body ?? {});
      if (parsed.error) return flashError(response, parsed.error);
      const loaded = await loadEditableZones(db);
      if (loaded.error) return flashError(response, loaded.error);
      const entry = catalogOf().find((e) => e.id === parsed.type);
      if (!entry) return flashError(response, "unknown-type");
      if (!placementAllows(entry, parsed.zone)) return flashError(response, "placement");
      // multiple:false is the controller's gate — block-ops is catalog-free.
      if (entry.multiple === false && typePresent(loaded.zones, parsed.type)) {
        return flashError(response, "duplicate");
      }
      const config = entry.defaultConfig ? structuredClone(entry.defaultConfig) : {};
      const result = addBlock(loaded.zones, { zone: parsed.zone, type: parsed.type, config, idFactory });
      return await applyAndSave(response, db, result, "added=1");
    } catch (error) {
      next(error);
    }
  });

  const moveHandler = (direction) => async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const loaded = await loadEditableZones(db);
      if (loaded.error) return flashError(response, loaded.error);
      const result = moveBlock(loaded.zones, { blockId: request.params.blockId, direction });
      return await applyAndSave(response, db, result, "moved=1");
    } catch (error) {
      next(error);
    }
  };
  router.post("/homepage/blocks/:blockId/move-up", moveHandler("up"));
  router.post("/homepage/blocks/:blockId/move-down", moveHandler("down"));

  router.post("/homepage/blocks/:blockId/move-to", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const zone = parseZone(request.body?.zone);
      if (!zone) return flashError(response, "invalid-zone");
      const loaded = await loadEditableZones(db);
      if (loaded.error) return flashError(response, loaded.error);
      const { blockId } = request.params;
      const node = findNode(loaded.zones, blockId);
      if (!node) return flashError(response, "not-found");
      const entry = catalogOf().find((e) => e.id === node.type);
      if (!placementAllows(entry, zone)) return flashError(response, "placement");
      const result = moveBlockToZone(loaded.zones, { blockId, zone });
      return await applyAndSave(response, db, result, "moved=1");
    } catch (error) {
      next(error);
    }
  });

  // Drag-end target (D4 enhancement); the no-JS path uses move-up/down.
  router.post("/homepage/blocks/:blockId/move-to-index", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const zone = parseZone(request.body?.zone);
      if (!zone) return flashError(response, "invalid-zone");
      const index = Number.parseInt(request.body?.index, 10);
      if (Number.isNaN(index)) return flashError(response, "invalid-index");
      const loaded = await loadEditableZones(db);
      if (loaded.error) return flashError(response, loaded.error);
      const { blockId } = request.params;
      const node = findNode(loaded.zones, blockId);
      if (!node) return flashError(response, "not-found");
      const entry = catalogOf().find((e) => e.id === node.type);
      if (!placementAllows(entry, zone)) return flashError(response, "placement");
      // remove + index-clamped restore = positional move, reusing the
      // immutable ops instead of inventing a third splice path.
      const removed = removeBlock(loaded.zones, { blockId });
      if (removed.error) return flashError(response, removed.error);
      const result = restoreBlock(removed.zones, { node: removed.removed.node, zone, index });
      return await applyAndSave(response, db, result, "moved=1");
    } catch (error) {
      next(error);
    }
  });

  router.post("/homepage/blocks/:blockId/remove", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const loaded = await loadEditableZones(db);
      if (loaded.error) return flashError(response, loaded.error);
      const result = removeBlock(loaded.zones, { blockId: request.params.blockId });
      if (result.error) return flashError(response, result.error);
      const saved = await persistZones(db, result.zones);
      if (!saved.ok) return flashError(response, saved.error);
      const entry = catalogOf().find((e) => e.id === result.removed.node.type);
      const params = new URLSearchParams({ removed: entry?.label ?? result.removed.node.type });
      const token = encodeUndoPayload(result.removed);
      if (token) params.set("u", token);
      else params.set("noUndo", "1"); // oversized payload — removal stands, undo unavailable
      response.redirect(303, `${HOME}?${params}`);
    } catch (error) {
      next(error);
    }
  });

  router.post("/homepage/blocks/restore", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const payload = parseUndoPayload(request.body?.u);
      if (!payload) return flashError(response, "undo-invalid");
      const loaded = await loadEditableZones(db);
      if (loaded.error) return flashError(response, loaded.error);
      // STRICT semantic gate — the token is client-held state. Worst case
      // after this gate: a valid block of a known type re-appears.
      const entry = catalogOf().find((e) => e.id === payload.node.type);
      if (!entry) return flashError(response, "unknown-type");
      if (!placementAllows(entry, payload.zone)) return flashError(response, "placement");
      const configCheck = validateConfigAgainstSchema(payload.node.config ?? {}, entry.schema);
      if (!configCheck.ok) return flashError(response, "undo-invalid");
      if (entry.multiple === false && typePresent(loaded.zones, payload.node.type)) {
        return flashError(response, "duplicate");
      }
      if (findNode(loaded.zones, payload.node.id)) return flashError(response, "duplicate");
      // Rebuild from validated parts (extra payload keys dropped); the RAW
      // validated config is persisted — gate, not transformer.
      const node = {
        block: "section",
        id: payload.node.id,
        type: payload.node.type,
        v: entry.version ?? 0, // catalog-authoritative — never the payload's
        config: payload.node.config ?? {},
      };
      const result = restoreBlock(loaded.zones, { node, zone: payload.zone, index: payload.index });
      return await applyAndSave(response, db, result, "restored=1");
    } catch (error) {
      next(error);
    }
  });

  router.post("/homepage/blocks/:blockId/config", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const loaded = await loadEditableZones(db);
      if (loaded.error) return flashError(response, loaded.error);
      const { blockId } = request.params;
      const node = findNode(loaded.zones, blockId);
      if (!node) return flashError(response, "not-found");
      const entry = catalogOf().find((e) => e.id === node.type);
      if (!entry) return flashError(response, "unknown-type");
      const parsed = parseConfigBody(request.body ?? {}, entry.schema);
      if (!parsed.ok) {
        // Re-render (200) with the block's panel open and field errors —
        // redirecting would lose the user's input context.
        const locals = await editorLocals(loaded.state, {}, {
          fieldErrors: parsed.errors,
          openBlockId: blockId,
        });
        return response.status(200).render(EDITOR_VIEW, locals);
      }
      const result = updateBlockConfig(loaded.zones, { blockId, config: parsed.config });
      return await applyAndSave(response, db, result, "saved=1");
    } catch (error) {
      next(error);
    }
  });

  router.post("/homepage/arrangement", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const arrangement = request.body?.arrangement;
      if (arrangement !== "stack" && arrangement !== "sidebar-right") {
        return flashError(response, "invalid-arrangement");
      }
      const loaded = await loadEditableZones(db);
      if (loaded.error) return flashError(response, loaded.error);
      let zones = { ...loaded.zones, arrangement };
      let sidebarMoved = 0;
      if (arrangement === "stack" && loaded.zones.sidebar.length > 0) {
        // Never silently drop sidebar blocks — append them to main and say so.
        sidebarMoved = loaded.zones.sidebar.length;
        zones = { ...zones, main: [...loaded.zones.main, ...loaded.zones.sidebar], sidebar: [] };
      }
      const params = new URLSearchParams({ arranged: "1" });
      if (sidebarMoved > 0) params.set("sidebarMoved", String(sidebarMoved));
      return await applyAndSave(response, db, { zones }, params);
    } catch (error) {
      next(error);
    }
  });

  router.post("/homepage/apply-recipe", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const preset = LAYOUT_PRESETS.find((p) => p.id === request.body?.recipeId);
      if (!preset) return flashError(response, "unknown-recipe");
      const state = await getEditorState(db, SURFACE_ID);
      if (state && treeToZones(state.tree).custom) {
        return flashError(response, "custom-tree"); // read-only means read-only
      }
      const tree = buildHomepageTree(preset, idFactory);
      if (state) await saveDraft(db, SURFACE_ID, tree);
      else await createDraftFromTree(db, SURFACE_ID, "homepage", tree);
      response.redirect(303, `${HOME}?recipe=1`);
    } catch (error) {
      next(error);
    }
  });

  router.post("/homepage/publish", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const result = await publishDraft(db, SURFACE_ID, catalogOf(), {
        ...(writeArtifact ? { writeArtifact } : {}),
        updatedBy: userIdent(),
      });
      if (result.ok) return response.redirect(303, `${HOME}?published=1`);
      if (result.error === "not-found") return flashError(response, "no-composition");
      if (result.error === "conflict") return flashError(response, "conflict");
      return flashError(response, "publish-invalid");
    } catch (error) {
      next(error);
    }
  });

  router.post("/homepage/discard", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      await discardDraft(db, SURFACE_ID);
      response.redirect(303, `${HOME}?discarded=1`);
    } catch (error) {
      next(error);
    }
  });

  router.post("/mode", async (request, response, next) => {
    try {
      const db = requireDb(response);
      if (!db) return;
      const mode = request.body?.mode;
      if (mode !== "simple" && mode !== "advanced") {
        return flashError(response, "invalid-mode");
      }
      await saveSiteConfig(Indiekit, { designMode: mode }, userIdent());
      response.redirect(303, HOME);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
