/**
 * Built-in sidebar widget types absorbed from @rmdes/indiekit-endpoint-homepage.
 * Pure data export — no logic.
 * @module presets/builtin-widgets
 */

export const BUILTIN_WIDGETS = Object.freeze([
  { id: "author-card", label: "Author Card", description: "h-card with author info", icon: "user", defaultConfig: {}, configSchema: {} },
  { id: "recent-posts", label: "Recent Posts", description: "Latest posts sidebar", icon: "file-text", defaultConfig: { maxItems: 5 }, configSchema: { maxItems: { type: "number", label: "Max items", min: 1, max: 20 } } },
  { id: "categories", label: "Categories", description: "Tag cloud", icon: "tag", defaultConfig: {}, configSchema: {} },
  { id: "search", label: "Search", description: "Site search box", icon: "search", defaultConfig: {}, configSchema: {} },
  { id: "social-activity", label: "Social Activity", description: "Bluesky and Mastodon feeds", icon: "message-circle", defaultConfig: {}, configSchema: {} },
  { id: "github-repos", label: "GitHub Projects", description: "GitHub repositories and activity", icon: "github", defaultConfig: {}, configSchema: {} },
  { id: "funkwhale", label: "Listening", description: "Funkwhale now playing and stats", icon: "music", defaultConfig: {}, configSchema: {} },
  { id: "blogroll", label: "Blogroll", description: "Blog recommendations", icon: "list", defaultConfig: {}, configSchema: {} },
  { id: "feedland", label: "FeedLand", description: "FeedLand blogroll widget", icon: "rss", defaultConfig: {}, configSchema: {} },
  { id: "webmentions", label: "Webmentions", description: "Recent inbound/outbound webmentions", icon: "message-circle", defaultConfig: {}, configSchema: {} },
  { id: "recent-comments", label: "Recent Comments", description: "Latest IndieAuth comments", icon: "message-square", defaultConfig: {}, configSchema: {} },
  { id: "fediverse-follow", label: "Fediverse Follow", description: "Follow button for fediverse instances", icon: "globe", defaultConfig: {}, configSchema: {} },
  { id: "ai-usage", label: "AI Transparency", description: "Compact AI usage stats and contribution graph", icon: "zap", defaultConfig: {}, configSchema: {} },
  { id: "custom-html", label: "Custom Content", description: "Freeform HTML or text block", icon: "code", defaultConfig: { title: "", content: "" }, configSchema: { title: { type: "text", label: "Title (optional)" }, content: { type: "textarea", label: "Content (HTML)" } } },
]);
