/**
 * Plugin discovery (spec §3.1). Reads the `get blocks()` v2 contract from every
 * loaded endpoint and merges it over the built-in seed on Map<id, entry> so
 * duplicate ids can't coexist. Precedence per id: built-in seed < plugin
 * `blocks` entry — a plugin declaration overwrites the seed and stamps
 * `sourcePlugin`. The sole output is the block catalog, consumed by the theme
 * via block-catalog.json (and by the v4 composition editor).
 *
 * Phase 7d follow-up: the legacy three-getter adapter (homepageSections /
 * homepageWidgets / blogPostWidgets + synthesizeLegacyEntry + the
 * discoveredSections/Widgets/BlogPostWidgets arrays behind /api/{sections,
 * widgets,blog-widgets}) was REMOVED. It only ever served the retired v3 admin
 * UI and the `@rmdes/indiekit-endpoint-homepage` plugin that site-config
 * replaced (May 2026); no deployment consumes it.
 *
 * Error containment is two-level: a per-ENDPOINT catch (a throwing `blocks`
 * getter skips that endpoint) plus a per-ENTRY catch (a poisoned entry —
 * throwing property getter/proxy — skips that entry only, never the plugin's
 * remaining valid entries).
 * @module discovery/scan-plugins
 */
import { BUILTIN_BLOCKS } from "../presets/builtin-blocks.js";
import { validBlockEntry } from "./block-entry.js";

/** Read entry.id without trusting it (poisoned getters must not escape the warn path). */
function safeId(entry) {
  try {
    return entry?.id;
  } catch {
    return undefined;
  }
}

/**
 * Read ep.name once, throw-proof. A throwing `name` getter would otherwise
 * defeat BOTH catch levels: the inner warn throws, the outer catch's warn
 * reads ep.name again and throws too — scanPlugins escapes to the boot
 * catch and NO discovery output is written at all.
 */
function safeName(ep) {
  try {
    const name = ep?.name;
    return typeof name === "string" ? name : "(unnamed endpoint)";
  } catch {
    return "(unnamed endpoint)";
  }
}

/** Throw-proof error text: `throw null` has no .message — degrade, don't TypeError. */
function errorText(error) {
  return error?.message ?? String(error);
}

export function scanPlugins(Indiekit, ownEndpoint) {
  // Built-in seed; each plugin's `get blocks()` overwrites its ids and stamps
  // sourcePlugin → requiresPlugin (so a block is in a site's catalog only when
  // its owning plugin is loaded — catalog presence is the theme's render gate).
  const catalog = new Map(BUILTIN_BLOCKS.map((e) => [e.id, e]));
  const blockDeclaredIds = new Set(); // ids declared via `blocks`

  for (const ep of Indiekit?.endpoints || []) {
    if (!ep || ep === ownEndpoint) continue;
    const epName = safeName(ep); // read ONCE, throw-proof — used in every warn path below
    try {
      for (const raw of Array.isArray(ep.blocks) ? ep.blocks : []) {
        try {
          const result = validBlockEntry(raw);
          if (!result.ok) {
            console.warn(`[site-config] skipping invalid block "${safeId(raw)}" from ${epName}: ${result.errors.join("; ")}`);
            continue;
          }
          // Cross-plugin collision on a `blocks` id: last-wins stays the
          // rule (Map semantics), but silently is not acceptable — surface it.
          if (blockDeclaredIds.has(raw.id)) {
            console.warn(`[site-config] block id "${raw.id}" declared by multiple plugins — ${epName} wins`);
          }
          catalog.set(raw.id, { ...raw, sourcePlugin: epName });
          blockDeclaredIds.add(raw.id);
        } catch (error) {
          console.warn(`[site-config] skipping unreadable block entry from ${epName}: ${errorText(error)}`);
        }
      }
    } catch (error) {
      console.warn(`[site-config] plugin scan failed for ${epName}: ${errorText(error)}`);
    }
  }

  const result = {
    catalog: [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };

  Indiekit.config.application.blockCatalog = result.catalog;

  console.log(`[site-config] discovered ${result.catalog.length} catalog blocks`);
  return result;
}
