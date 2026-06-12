/**
 * Blocks contract v2 catalog entries for the plugin's built-in blocks
 * (spec §3.1). Hand-authored ONE TIME from the legacy presets
 * (builtin-sections.js, builtin-widgets.js, builtin-blog-post-widgets.js) —
 * richer than a mechanical convertMiniDsl pass: count fields are upgraded to
 * bounded integers, custom-html content gets the markdown control, and the
 * four dual-origin ids (recent-posts, custom-html, ai-usage, recent-comments)
 * are merged into single entries carrying both regions. 26 legacy entries →
 * 22 unique catalog entries. Every entry must pass validBlockEntry
 * (lib/discovery/block-entry.js) — enforced by tests/builtin-blocks.test.js.
 *
 * Conventions:
 * - "Bespoke" blocks (theme partial renders them) OMIT the `render` field.
 * - Schemas never use `required`: legacy configs may omit any field, and the
 *   migrator validates them against these schemas — a required field missing
 *   from a legacy config would fail migration.
 * - Where the two legacy variants of a dual-origin id declared DIFFERENT
 *   defaults (recent-posts maxItems: section 10 vs widget 5), the catalog
 *   default uses the MAIN/section variant's value. The sidebar-specific
 *   default is a zone-preset concern for Phase 4, not a catalog concern.
 * - The spec's global maxItems ≤ 50 cap is encoded directly in each count
 *   field's schema (maximum: 50), not special-cased in the validator.
 *
 * `embed` is deliberately absent — it lands in Phase 3 with its renderer.
 * @module presets/builtin-blocks
 */

export const BUILTIN_BLOCKS = Object.freeze([
  Object.freeze({
    id: "hero",
    version: 1,
    label: "Hero Section",
    description: "Author intro with avatar, name, title, and bio",
    icon: "user",
    category: "content",
    placement: Object.freeze({
      regions: Object.freeze(["hero"]),
      surfaces: Object.freeze(["homepage", "standalone"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        showAvatar: Object.freeze({
          type: "boolean",
          title: "Show avatar",
          default: true,
        }),
        showSocialLinks: Object.freeze({
          type: "boolean",
          title: "Show social links",
          default: true,
        }),
      }),
    }),
    data: Object.freeze({ source: "config" }),
  }),
  Object.freeze({
    id: "featured-posts",
    version: 1,
    label: "Featured Posts",
    description: "Curated posts pinned as featured",
    icon: "star",
    category: "posts",
    placement: Object.freeze({
      regions: Object.freeze(["main"]),
      surfaces: Object.freeze(["homepage", "collection"]),
    }),
    multiple: true,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        maxItems: Object.freeze({
          type: "integer",
          title: "Max items",
          minimum: 1,
          maximum: 50,
          default: 6,
        }),
        showSummary: Object.freeze({
          type: "boolean",
          title: "Show post summary",
          default: true,
        }),
      }),
    }),
    data: Object.freeze({ source: "collections", key: "featuredPosts" }),
    render: Object.freeze({ renderer: "feed" }),
  }),
  Object.freeze({
    id: "recent-posts",
    version: 1,
    label: "Recent Posts",
    description: "Latest posts from your blog",
    icon: "file-text",
    category: "posts",
    placement: Object.freeze({
      regions: Object.freeze(["main", "sidebar"]),
      surfaces: Object.freeze(["homepage", "collection", "postType"]),
    }),
    multiple: true,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        // Section variant default (10) — the widget variant's 5 is a
        // zone-preset concern for Phase 4 (see module comment).
        maxItems: Object.freeze({
          type: "integer",
          title: "Max items",
          minimum: 1,
          maximum: 50,
          default: 10,
        }),
        postTypes: Object.freeze({
          type: "array",
          title: "Post types to include",
          items: Object.freeze({ type: "string" }),
          default: Object.freeze(["note", "article", "photo", "bookmark"]),
        }),
      }),
    }),
    data: Object.freeze({ source: "collections", key: "posts" }),
    render: Object.freeze({
      renderer: "feed",
      variants: Object.freeze({ sidebar: "list" }),
    }),
  }),
  Object.freeze({
    id: "custom-html",
    version: 1,
    label: "Custom Content",
    description: "Freeform HTML or Markdown block",
    icon: "code",
    category: "content",
    placement: Object.freeze({
      regions: Object.freeze(["main", "sidebar", "footer"]),
      surfaces: Object.freeze([
        "homepage",
        "collection",
        "postType",
        "standalone",
      ]),
    }),
    multiple: true,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        title: Object.freeze({
          type: "string",
          title: "Title (optional)",
          maxLength: 200,
        }),
        content: Object.freeze({
          type: "string",
          title: "Content (HTML/Markdown)",
          maxLength: 20_000,
          "x-control": "markdown",
        }),
      }),
    }),
    data: Object.freeze({ source: "config" }),
    render: Object.freeze({ renderer: "prose" }),
  }),
  Object.freeze({
    id: "posting-activity",
    version: 1,
    label: "Posting Activity",
    description: "GitHub-style contribution graph showing posting frequency",
    icon: "activity",
    category: "posts",
    placement: Object.freeze({
      regions: Object.freeze(["main"]),
      surfaces: Object.freeze(["homepage"]),
    }),
    multiple: true,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        title: Object.freeze({
          type: "string",
          title: "Section title",
          maxLength: 200,
          default: "Posting Activity",
        }),
        years: Object.freeze({
          type: "string",
          title: "Years to show (comma-separated, e.g. 2026,2025)",
          maxLength: 200,
        }),
        // Year count, not a feed length — keeps the legacy 0–10 bounds
        // rather than the maxItems-style 1–50 cap.
        limit: Object.freeze({
          type: "integer",
          title: "Number of years (ignored if specific years set)",
          minimum: 0,
          maximum: 10,
          default: 1,
        }),
      }),
    }),
    data: Object.freeze({ source: "collections", key: "posts" }),
  }),
  Object.freeze({
    id: "ai-usage",
    version: 1,
    label: "AI Transparency",
    description: "AI usage stats, level breakdown, and contribution graph",
    icon: "zap",
    category: "content",
    placement: Object.freeze({
      regions: Object.freeze(["main", "sidebar"]),
      surfaces: Object.freeze(["homepage", "standalone"]),
    }),
    multiple: true,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        title: Object.freeze({
          type: "string",
          title: "Section title",
          maxLength: 200,
          default: "AI Transparency",
        }),
        // Year count — legacy 1–10 bounds (see posting-activity note).
        limit: Object.freeze({
          type: "integer",
          title: "Years to show in graph",
          minimum: 1,
          maximum: 10,
          default: 1,
        }),
      }),
    }),
    data: Object.freeze({ source: "config" }),
  }),
  Object.freeze({
    id: "author-card",
    version: 1,
    label: "Author Card",
    description: "h-card with author info",
    icon: "user",
    category: "identity",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar"]),
      surfaces: Object.freeze(["homepage", "collection", "postType"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "config" }),
  }),
  Object.freeze({
    id: "categories",
    version: 1,
    label: "Categories",
    description: "Tag cloud",
    icon: "tag",
    category: "posts",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar"]),
      surfaces: Object.freeze(["homepage", "collection"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "collections", key: "categories" }),
    render: Object.freeze({ renderer: "tag-cloud" }),
  }),
  Object.freeze({
    id: "search",
    version: 1,
    label: "Search",
    description: "Site search box",
    icon: "search",
    category: "content",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar"]),
      surfaces: Object.freeze(["homepage", "collection"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "config" }),
  }),
  Object.freeze({
    id: "social-activity",
    version: 1,
    label: "Social Activity",
    description: "Bluesky and Mastodon feeds",
    icon: "message-circle",
    category: "social",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar"]),
      surfaces: Object.freeze(["homepage"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "api" }),
  }),
  Object.freeze({
    id: "github-repos",
    version: 1,
    label: "GitHub Projects",
    description: "GitHub repositories and activity",
    icon: "github",
    category: "social",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar"]),
      surfaces: Object.freeze(["homepage"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "api" }),
  }),
  Object.freeze({
    id: "funkwhale",
    version: 1,
    label: "Listening",
    description: "Funkwhale now playing and stats",
    icon: "music",
    category: "social",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar"]),
      surfaces: Object.freeze(["homepage"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "api" }),
  }),
  Object.freeze({
    id: "blogroll",
    version: 1,
    label: "Blogroll",
    description: "Blog recommendations",
    icon: "list",
    category: "social",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar"]),
      surfaces: Object.freeze(["homepage"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "api" }),
  }),
  Object.freeze({
    id: "feedland",
    version: 1,
    label: "FeedLand",
    description: "FeedLand blogroll widget",
    icon: "rss",
    category: "social",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar"]),
      surfaces: Object.freeze(["homepage"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "api" }),
  }),
  Object.freeze({
    id: "webmentions",
    version: 1,
    label: "Webmentions",
    description: "Recent inbound/outbound webmentions",
    icon: "message-circle",
    category: "social",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar"]),
      surfaces: Object.freeze(["homepage", "postType"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "api" }),
  }),
  Object.freeze({
    id: "recent-comments",
    version: 1,
    label: "Recent Comments",
    description: "Latest IndieAuth comments",
    icon: "message-square",
    category: "social",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar"]),
      surfaces: Object.freeze(["homepage", "postType"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "api" }),
  }),
  Object.freeze({
    id: "fediverse-follow",
    version: 1,
    label: "Fediverse Follow",
    description: "Follow button for fediverse instances",
    icon: "globe",
    category: "social",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar"]),
      surfaces: Object.freeze(["homepage"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "config" }),
  }),
  Object.freeze({
    id: "author-card-compact",
    version: 1,
    label: "Author Card (Compact)",
    description: "Compact h-card with avatar and name",
    icon: "user",
    category: "identity",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar"]),
      surfaces: Object.freeze(["postType"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "config" }),
  }),
  Object.freeze({
    id: "toc",
    version: 1,
    label: "Table of Contents",
    description: "Auto-generated from headings",
    icon: "list",
    category: "content",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar"]),
      surfaces: Object.freeze(["postType"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "config" }),
  }),
  Object.freeze({
    id: "post-categories",
    version: 1,
    label: "Post Categories",
    description: "Categories for the current post",
    icon: "tag",
    category: "posts",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar"]),
      surfaces: Object.freeze(["postType"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "config" }),
  }),
  Object.freeze({
    id: "share",
    version: 1,
    label: "Share",
    description: "Share on Bluesky and Mastodon",
    icon: "share",
    category: "content",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar"]),
      surfaces: Object.freeze(["postType"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "config" }),
  }),
  Object.freeze({
    id: "subscribe",
    version: 1,
    label: "Subscribe",
    description: "RSS and JSON feed links",
    icon: "rss",
    category: "content",
    placement: Object.freeze({
      regions: Object.freeze(["sidebar", "footer"]),
      surfaces: Object.freeze(["postType", "homepage"]),
    }),
    multiple: false,
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    data: Object.freeze({ source: "config" }),
  }),
]);
