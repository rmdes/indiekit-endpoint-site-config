/**
 * Built-in section types absorbed from @rmdes/indiekit-endpoint-homepage.
 * Pure data export — no logic.
 * @module presets/builtin-sections
 */

export const BUILTIN_SECTIONS = Object.freeze([
  {
    id: "hero",
    label: "Hero Section",
    description: "Author intro with avatar, name, title, and bio",
    icon: "user",
    dataEndpoint: null,
    defaultConfig: { showAvatar: true, showSocialLinks: true },
    configSchema: {
      showAvatar: { type: "boolean", label: "Show avatar" },
      showSocialLinks: { type: "boolean", label: "Show social links" },
    },
  },
  {
    id: "featured-posts",
    label: "Featured Posts",
    description: "Curated posts pinned as featured",
    icon: "star",
    dataEndpoint: null,
    defaultConfig: { maxItems: 6, showSummary: true },
    configSchema: {
      maxItems: { type: "number", label: "Max items", min: 1, max: 20 },
      showSummary: { type: "boolean", label: "Show post summary" },
    },
  },
  {
    id: "recent-posts",
    label: "Recent Posts",
    description: "Latest posts from your blog",
    icon: "file-text",
    dataEndpoint: null,
    defaultConfig: { maxItems: 10, postTypes: ["note", "article", "photo", "bookmark"] },
    configSchema: {
      maxItems: { type: "number", label: "Max items", min: 1, max: 50 },
      postTypes: { type: "array", label: "Post types to include" },
    },
  },
  {
    id: "custom-html",
    label: "Custom Content",
    description: "Freeform HTML or Markdown block",
    icon: "code",
    dataEndpoint: null,
    defaultConfig: { content: "" },
    configSchema: {
      content: { type: "textarea", label: "Content (HTML/Markdown)" },
    },
  },
  {
    id: "posting-activity",
    label: "Posting Activity",
    description: "GitHub-style contribution graph showing posting frequency",
    icon: "activity",
    dataEndpoint: null,
    defaultConfig: { title: "Posting Activity", limit: 1 },
    configSchema: {
      title: { type: "text", label: "Section title" },
      years: { type: "text", label: "Years to show (comma-separated, e.g. 2026,2025)" },
      limit: { type: "number", label: "Number of years (ignored if specific years set)", min: 0, max: 10 },
    },
  },
  {
    id: "ai-usage",
    label: "AI Transparency",
    description: "AI usage stats, level breakdown, and contribution graph",
    icon: "zap",
    dataEndpoint: null,
    defaultConfig: { title: "AI Transparency", limit: 1 },
    configSchema: {
      title: { type: "text", label: "Section title" },
      limit: { type: "number", label: "Years to show in graph", min: 1, max: 10 },
    },
  },
]);
