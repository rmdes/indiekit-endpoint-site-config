/**
 * Category census (Category Governance, Layer 2).
 *
 * The Categories tab counts + lists categories from the SAME source the Eleventy
 * theme builds from: the content `.md` frontmatter (NOT the MongoDB `posts`
 * collection, which holds only the Indiekit-managed subset and misses ~1,592
 * migrated legacy files — see the design doc's "counts + merge source" decision).
 *
 * This module's pure core (`slugifyCategory`, `indexCategories`) groups raw
 * frontmatter category values by slug (case-insensitive) and tracks the distinct
 * casing VARIANTS per slug — so the tab can surface merge candidates (slugs with
 * more than one variant, e.g. Politics/politics) and a de-facto canonical name
 * (the most-used casing). The filesystem reader lives alongside (uses gray-matter
 * to parse frontmatter); it's kept thin so the grouping logic unit-tests without
 * touching disk.
 *
 * @module storage/category-census
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

/**
 * Slugify a category name (lowercase, alnum + single hyphens). Mirrors the
 * theme's lib/categories.mjs slugifyCategory so the tab's grouping matches the
 * build's. (Cross-repo: intentionally duplicated, not shared.)
 * @param {unknown} str
 * @returns {string}
 */
export function slugifyCategory(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build the category index from each post's raw `category` frontmatter value.
 *
 * @param {Array<unknown>} categoryValuesPerPost - one entry per post: a string,
 *   an array of strings, or anything (non-strings ignored)
 * @returns {Array<{slug:string, name:string, count:number,
 *   variants:Array<{name:string, count:number}>}>}
 *   sorted by count desc then slug asc; `name` is the most-used variant;
 *   `variants` are the distinct casings sorted by count desc then name asc.
 */
export function indexCategories(categoryValuesPerPost) {
  const bySlug = new Map(); // slug -> { slug, count, variants: Map<name, count> }

  for (const raw of Array.isArray(categoryValuesPerPost) ? categoryValuesPerPost : []) {
    const cats = Array.isArray(raw) ? raw : [raw];
    for (const cat of cats) {
      if (typeof cat !== "string" || !cat.trim()) continue;
      const name = cat.trim();
      const slug = slugifyCategory(name);
      if (!slug) continue;
      let entry = bySlug.get(slug);
      if (!entry) {
        entry = { slug, count: 0, variants: new Map() };
        bySlug.set(slug, entry);
      }
      entry.count += 1;
      entry.variants.set(name, (entry.variants.get(name) || 0) + 1);
    }
  }

  return [...bySlug.values()]
    .map((entry) => {
      const variants = [...entry.variants.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      return { slug: entry.slug, name: variants[0].name, count: entry.count, variants };
    })
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
}

// Brief in-process cache — the admin GET parses ~2,600 .md files; invalidated
// after a merge (which mutates frontmatter) via invalidateCensusCache().
let _cache = { dir: null, at: 0, index: null };
const CENSUS_TTL_MS = 60_000;

/**
 * Read all `.md` frontmatter categories under a content dir → category index.
 * The source of truth for the Categories tab (matches the Eleventy build, which
 * reads the same files). Unparseable files are skipped. Missing dir → [].
 *
 * @param {string} contentDir
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.ttl] - cache TTL ms (0 disables the cache)
 * @returns {ReturnType<typeof indexCategories>}
 */
export function censusFromContentDir(contentDir, options = {}) {
  const { now = Date.now, ttl = CENSUS_TTL_MS } = options;
  const t = now();
  if (ttl > 0 && _cache.dir === contentDir && _cache.index && t - _cache.at < ttl) {
    return _cache.index;
  }
  let files;
  try {
    files = readdirSync(contentDir, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const values = [];
  for (const rel of files) {
    if (typeof rel !== "string" || !rel.endsWith(".md")) continue;
    try {
      const { data } = matter(readFileSync(join(contentDir, rel), "utf8"));
      if (data && data.category) values.push(data.category);
    } catch {
      /* skip unparseable frontmatter */
    }
  }
  const index = indexCategories(values);
  _cache = { dir: contentDir, at: t, index };
  return index;
}

/** Drop the census cache (call after a merge mutates .md frontmatter). */
export function invalidateCensusCache() {
  _cache = { dir: null, at: 0, index: null };
}
