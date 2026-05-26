/**
 * Layout presets — quick-start configurations for common homepage styles.
 * @module presets/layout-presets
 */

export const LAYOUT_PRESETS = Object.freeze([
  {
    id: "blog",
    label: "Blog",
    description: "Recent posts front and center",
    icon: "newspaper",
    layout: "two-column",
    hero: { enabled: true, showSocial: true },
    sections: [
      { type: "hero", config: {} },
      { type: "recent-posts", config: { maxItems: 15 } },
    ],
    sidebar: [
      { type: "search", config: {} },
      { type: "author-card", config: {} },
      { type: "social-activity", config: {} },
      { type: "recent-posts", config: { maxItems: 5 } },
    ],
    footer: [],
  },
  {
    id: "cv",
    label: "CV / Portfolio",
    description: "Professional profile with experience and projects",
    icon: "briefcase",
    layout: "full-width-hero",
    hero: { enabled: true, showSocial: true },
    sections: [
      { type: "hero", config: {} },
      { type: "cv-experience", config: {} },
      { type: "cv-skills", config: {} },
      { type: "cv-projects", config: {} },
      { type: "cv-education", config: {} },
      { type: "cv-interests", config: {} },
    ],
    sidebar: [
      { type: "search", config: {} },
      { type: "social-activity", config: {} },
      { type: "github-repos", config: {} },
      { type: "blogroll", config: {} },
      { type: "recent-posts", config: {} },
      { type: "funkwhale", config: {} },
      { type: "author-card", config: {} },
    ],
    footer: [],
  },
  {
    id: "hybrid",
    label: "Hybrid",
    description: "Blog posts with CV highlights",
    icon: "layout",
    layout: "two-column",
    hero: { enabled: true, showSocial: true },
    sections: [
      { type: "hero", config: {} },
      { type: "cv-experience", config: { maxItems: 3 } },
      { type: "recent-posts", config: { maxItems: 10 } },
      { type: "cv-projects", config: { maxItems: 3 } },
    ],
    sidebar: [
      { type: "search", config: {} },
      { type: "author-card", config: {} },
      { type: "social-activity", config: {} },
      { type: "github-repos", config: {} },
      { type: "blogroll", config: {} },
    ],
    footer: [],
  },
]);
