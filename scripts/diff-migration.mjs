#!/usr/bin/env node
/**
 * Phase 2 production diff — v3 homepage artifact vs migrated v4 tree.
 *
 * Usage:
 *   node scripts/diff-migration.mjs <url-or-file> [--extra-blocks <file>]
 *   node scripts/diff-migration.mjs https://rmendes.net/site-config/api/homepage.json
 *   node scripts/diff-migration.mjs /tmp/v3-fixture.json
 *
 * --extra-blocks <file>: JSON array of additional catalog entries merged
 * over BUILTIN_BLOCKS. The PRODUCTION migration (index.js boot) validates
 * against the full scanned catalog (BUILTIN_BLOCKS + plugin-declared/
 * synthesized legacy entries, see lib/discovery/scan-plugins.js) — sites
 * whose v3 config uses plugin section types (e.g. the CV plugin's
 * cv-*-personal) need their synthesized entries supplied here to reproduce
 * the production validation verdict. Without it, this script's verdict is
 * STRICTER than production (unknown plugin types report as errors).
 *
 * Fetches (or reads) a v3 homepage config JSON, runs buildHomepageTree +
 * validateComposition against BUILTIN_BLOCKS, and prints:
 *   - per-zone ordered type lists: v3 sections[]/sidebar[]/footer[] vs the
 *     types extracted from the migrated tree's main/complementary/contentinfo
 *     containers (must be equal after dropping v3's skipped in-sections hero
 *     entries, and after applying v3's layout gating of the sidebar)
 *   - the validation verdict and any config keys the stripUnknown pass
 *     dropped (warnings)
 *
 * Exit codes: 0 = all zones match and validation ok; 1 = any mismatch or
 * validation error; 2 = source unreadable (bad URL/file/JSON).
 *
 * Read-only: never touches a database; safe against production (public,
 * unauthenticated artifact).
 */
import { readFile, writeFile } from "node:fs/promises";

import { buildHomepageTree } from "../lib/storage/migrate-v3-to-v4.js";
import { validateComposition } from "../lib/validators/composition.js";
import { BUILTIN_BLOCKS } from "../lib/presets/builtin-blocks.js";

const args = process.argv.slice(2);
const extraBlocksIndex = args.indexOf("--extra-blocks");
let extraBlocksFile = null;
if (extraBlocksIndex !== -1) {
  [, extraBlocksFile] = args.splice(extraBlocksIndex, 2);
}
const emitIndex = args.indexOf("--emit");
let emitFile = null;
if (emitIndex !== -1) {
  [, emitFile] = args.splice(emitIndex, 2);
}
const [source] = args;
if (!source || (extraBlocksIndex !== -1 && !extraBlocksFile)) {
  console.error("usage: node scripts/diff-migration.mjs <url-or-file> [--extra-blocks <file>]");
  process.exit(2);
}

/** Load the v3 homepage config from an HTTPS URL or a local file. */
async function loadV3(from) {
  if (/^https?:\/\//.test(from)) {
    const response = await fetch(from, {
      headers: { accept: "application/json" },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for ${from}`);
    }
    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();
    if (!contentType.includes("json")) {
      throw new Error(
        `non-JSON content-type "${contentType}" for ${from} ` +
          `(first 120 chars: ${JSON.stringify(body.slice(0, 120))})`,
      );
    }
    return JSON.parse(body);
  }
  return JSON.parse(await readFile(from, "utf8"));
}

let v3;
try {
  v3 = await loadV3(source);
} catch (error) {
  console.error(`FATAL: could not load v3 config from ${source}`);
  console.error(`  ${error.message}`);
  process.exit(2);
}
if (!v3 || typeof v3 !== "object" || Array.isArray(v3)) {
  console.error(`FATAL: source did not parse to a plain object: ${source}`);
  process.exit(2);
}

let catalog = BUILTIN_BLOCKS;
if (extraBlocksFile) {
  try {
    const extra = JSON.parse(await readFile(extraBlocksFile, "utf8"));
    if (!Array.isArray(extra)) throw new Error("extra-blocks file must contain a JSON array");
    catalog = [...BUILTIN_BLOCKS, ...extra];
    console.log(`catalog: BUILTIN_BLOCKS + ${extra.length} extra entr${extra.length === 1 ? "y" : "ies"} from ${extraBlocksFile}`);
  } catch (error) {
    console.error(`FATAL: could not load extra blocks from ${extraBlocksFile}`);
    console.error(`  ${error.message}`);
    process.exit(2);
  }
} else {
  console.log("catalog: BUILTIN_BLOCKS only (stricter than production's scanned catalog)");
}

console.log(`source: ${source}`);
console.log(`v3 layout: ${JSON.stringify(v3.layout)}  hero.enabled: ${Boolean(v3.hero?.enabled)}`);

// Deterministic sequential ids — diff output stays stable across runs.
const seq = (() => {
  let n = 0;
  return (prefix) => `${prefix}_${String(++n).padStart(4, "0")}`;
})();

const tree = buildHomepageTree(v3, seq);
const doc = {
  _id: "homepage",
  schemaVersion: 4,
  kind: "homepage",
  status: "published",
  tree,
};
const result = validateComposition(doc, catalog, { stripUnknown: true });

if (emitFile) {
  await writeFile(emitFile, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`emitted v4 doc: ${emitFile}`);
}

/**
 * Flatten the migrated tree into zone → ordered type list. A section's zone
 * is the role of its nearest enclosing container, EXCEPT that "root" and
 * "region" (the 2-1 columns wrapper) are structural, not zones — sections
 * directly under them (only the hero, in trees buildHomepageTree produces)
 * land in the "_top" bucket, which both sides exclude from comparison.
 */
const ZONE_ROLES = new Set(["main", "complementary", "contentinfo"]);
function flatten(node, zone, out) {
  if (node.block === "container") {
    const nextZone = ZONE_ROLES.has(node.role) ? node.role : zone;
    for (const child of node.children || []) flatten(child, nextZone, out);
  } else {
    (out[zone] ||= []).push(node.type);
  }
  return out;
}
const migrated = flatten(tree, "_top", {});

// v3 expectations, mirroring the verified v3 renderer semantics the migrator
// encodes: typeless entries dropped everywhere; in-sections hero entries
// skipped; the sidebar only renders when layout is two-column or
// full-width-hero AND it is non-empty (otherwise single-column degradation).
const types = (value) =>
  (Array.isArray(value) ? value : [])
    .filter((entry) => entry?.type)
    .map((entry) => entry.type);
const v3SectionTypes = types(v3.sections);
const droppedHeroes = v3SectionTypes.filter((t) => t === "hero").length;
const sidebarRenders =
  types(v3.sidebar).length > 0 &&
  (v3.layout === "two-column" || v3.layout === "full-width-hero");
const v3Types = {
  main: v3SectionTypes.filter((t) => t !== "hero"),
  complementary: sidebarRenders ? types(v3.sidebar) : [],
  contentinfo: types(v3.footer),
};

let failed = false;
for (const [zone, expected] of Object.entries(v3Types)) {
  const got = migrated[zone] || [];
  if (JSON.stringify(got) === JSON.stringify(expected)) {
    console.log(`OK ${zone}: [${got.join(", ")}]`);
  } else {
    console.error(`MISMATCH ${zone}:`);
    console.error(`  v3 expected: [${expected.join(", ")}]`);
    console.error(`  v4 migrated: [${got.join(", ")}]`);
    failed = true;
  }
}

// Hero placement sanity: doc-level enabled hero must surface exactly once,
// at top level, ahead of the zones.
const topTypes = migrated._top || [];
const expectedTop = v3.hero?.enabled ? ["hero"] : [];
if (JSON.stringify(topTypes) === JSON.stringify(expectedTop)) {
  console.log(`OK hero: top-level [${topTypes.join(", ")}]`);
} else {
  console.error(
    `MISMATCH hero: expected top-level [${expectedTop.join(", ")}] got [${topTypes.join(", ")}]`,
  );
  failed = true;
}
if (droppedHeroes > 0) {
  console.log(
    `note: dropped ${droppedHeroes} in-sections hero entr${droppedHeroes === 1 ? "y" : "ies"} ` +
      "(v3 renderer skips them — excluded from both sides of the diff)",
  );
}
if (types(v3.sidebar).length > 0 && !sidebarRenders) {
  console.log(
    `note: v3 sidebar has ${types(v3.sidebar).length} entr(ies) but layout ` +
      `"${v3.layout}" degrades to single-column — v3 renderer drops it, so the migrator does too`,
  );
}

console.log(
  `validation: ok=${result.ok} errors=${result.errors.length} warnings=${result.warnings.length}`,
);
for (const warning of result.warnings) console.log(`  warn: ${warning}`);
for (const error of result.errors) console.error(`  ERROR: ${error}`);
if (!result.ok) failed = true;

console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(failed ? 1 : 0);
