/**
 * Default values for homepageConfig collection (composition).
 * Singleton _id: "homepage".
 *
 * Schema (unification):
 *   - layout: "single-column" | "two-column" | "full-width-hero"
 *   - hero: { enabled, showSocial }
 *   - sections[]: built-in or plugin-declared section entries
 *   - sidebar[]: widgets for homepage sidebar
 *   - blogListingSidebar[]: widgets for /blog listing page sidebar
 *   - blogPostSidebar[]: widgets for individual blog post sidebar
 *   - footer[]: footer column entries
 *
 * Frozen for immutability — never mutate this object directly.
 * @module storage/defaults-homepage
 */

export const DEFAULTS_HOMEPAGE = Object.freeze({
  layout: "two-column",
  hero: Object.freeze({
    enabled: true,
    showSocial: true,
  }),
  sections: Object.freeze([
    Object.freeze({
      type: "recent-posts",
      config: Object.freeze({
        maxItems: 10,
        postTypes: Object.freeze(["note", "article"]),
      }),
    }),
  ]),
  sidebar: Object.freeze([
    Object.freeze({ type: "author-card", config: Object.freeze({}) }),
    Object.freeze({ type: "recent-posts", config: Object.freeze({ maxItems: 5 }) }),
    Object.freeze({ type: "categories", config: Object.freeze({}) }),
  ]),
  blogListingSidebar: Object.freeze([]),
  blogPostSidebar: Object.freeze([]),
  footer: Object.freeze([]),
});
