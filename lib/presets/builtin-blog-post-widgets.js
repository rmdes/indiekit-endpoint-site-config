/**
 * Built-in blog-post-specific sidebar widgets absorbed from @rmdes/indiekit-endpoint-homepage.
 * Universal sidebar widgets (from builtin-widgets.js) are merged in at scan time.
 * @module presets/builtin-blog-post-widgets
 */

export const BUILTIN_BLOG_POST_WIDGETS = Object.freeze([
  { id: "author-card-compact", label: "Author Card (Compact)", description: "Compact h-card with avatar and name", icon: "user", defaultConfig: {}, configSchema: {} },
  { id: "toc", label: "Table of Contents", description: "Auto-generated from headings", icon: "list", defaultConfig: {}, configSchema: {} },
  { id: "post-categories", label: "Post Categories", description: "Categories for the current post", icon: "tag", defaultConfig: {}, configSchema: {} },
  { id: "share", label: "Share", description: "Share on Bluesky and Mastodon", icon: "share", defaultConfig: {}, configSchema: {} },
  { id: "subscribe", label: "Subscribe", description: "RSS and JSON feed links", icon: "rss", defaultConfig: {}, configSchema: {} },
  { id: "recent-comments", label: "Recent Comments", description: "Latest IndieAuth comments", icon: "message-square", defaultConfig: {}, configSchema: {} },
]);
