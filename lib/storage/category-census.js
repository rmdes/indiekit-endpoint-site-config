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
