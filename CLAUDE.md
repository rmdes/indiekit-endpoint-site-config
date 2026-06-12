# CLAUDE.md — Site Config Endpoint

## Package Overview

`@rmdes/indiekit-endpoint-site-config` is the central hub for site identity,
branding, and configuration in Indiekit. It provides an admin UI for multi-site
deployments where all sites share a single Eleventy theme, plus a plugin
discovery system that enables other plugins to register homepage sections and
widgets without hard-coding them into the theme.

**Key capabilities:**

- Multi-tab admin UI: identity, branding, homepage, blog, navigation, general
- Runtime CSS generation (`theme.css`, `critical.css`) with APCA Lc contrast validation
- Homepage builder with drag-drop sections discovered from registered plugins
- Plugin discovery: scans `homepageSections`, `homepageWidgets`, `blogPostWidgets`
- Public APIs for theme integration: `/api/sections`, `/api/widgets`, `/api/homepage.json`
- Version history (last 10 saves in MongoDB, one-click revert)

**Registry status:** Core tier in `indiekit-cloudron` (always loaded, cannot be disabled)

**npm Package:** `@rmdes/indiekit-endpoint-site-config`

**Version:** See `package.json`

**Mount Path:** `/site-config` (default, configurable)

## Architecture

### Directory Structure

```
lib/
├── controllers/        # Route handlers (identity, branding, homepage, blog, navigation, general, api)
├── storage/            # MongoDB operations (get/save, seed from env, backfill)
├── discovery/          # Plugin scanning (scan-plugins.js)
├── render/             # File generation (write theme.css, critical.css, site-config.json, homepage.json)
├── presets/            # Layout presets, palette templates
└── validators/         # Schema validation, contrast checking
views/                  # Nunjucks admin templates (one per tab + partials)
locales/                # i18n strings (multiple languages)
```

### Initialization (init method)

1. Register endpoint with Indiekit: `Indiekit.addEndpoint(this)`
2. Register MongoDB collections: `siteConfig`, `homepageConfig`, `compositions`
3. Set content directory: `Indiekit.config.application.contentDir`
4. Mount admin routes (protected by session auth)
5. Mount public API routes
6. **First boot only:**
   - Seed from environment variables (`maybeSeedFromEnv`)
   - Backfill identity from Indiekit config (`maybeBackfillIdentity`)
   - Generate theme files: `theme.css`, `critical.css`, `site-config.json`, `homepage.json`
7. **Deferred plugin discovery** (via `process.nextTick`):
   - Scan all plugins in `Indiekit.endpoints` for `homepageSections`, `homepageWidgets`, `blogPostWidgets`
   - Cache available sections/widgets for the admin UI and public API

### MongoDB Collections

#### siteConfig

Singleton document `_id: "primary"` with schema version 3. Contains:

```javascript
{
  _id: "primary",
  schemaVersion: 3,
  identity: {
    name: String,        // Site name (e.g., "rmendes.net")
    domain: String,      // Domain used in og:url, etc.
    author: String,      // Person/entity name
    language: String,    // ISO 639-1 code (e.g., "en", "fr")
  },
  branding: {
    mode: "light" | "dark" | "auto",
    palettePreset: String | null,
    semanticTokens: { ... },
    customPalette: { ... },
  },
  navigation: {
    items: Array,
  },
  blog: {
    postsPerPage: Number,
    sortOrder: "asc" | "desc",
  },
  general: { ... },
  history: [
    { timestamp: Date, snapshot: Object },  // Last 10 saves
  ],
  createdAt: Date,
  updatedAt: Date,
}
```

**Indexes:**
- `_id` (primary)
- `updatedAt` (for history queries)

#### homepageConfig

Singleton document `_id: "homepage"` with homepage builder state:

```javascript
{
  _id: "homepage",
  hero: {
    enabled: Boolean,          // hero renders before the layout wrapper when true
    showSocial: Boolean,
    ctaText: String,           // e.g., "Read more"
    ctaUrl: String,            // e.g., "/about/"
  },
  layout: "single-column" | "two-column" | "full-width-hero",
  sections: [
    {
      id: String,              // e.g., "cv-experience" (from plugin)
      label: String,           // e.g., "Experience"
      enabled: Boolean,
      order: Number,
    },
  ],
  widgets: [
    {
      id: String,
      label: String,
      enabled: Boolean,
      order: Number,
    },
  ],
  createdAt: Date,
  updatedAt: Date,
}
```

#### compositions

Site-builder v4 composition documents (`schemaVersion: 4`) — one document per
surface (`homepage`, `collection:default`, `posttype:default`), seeded at boot
by the dual-running v3 → v4 migration (`lib/storage/migrate-v3-to-v4.js`,
seed-if-absent: never touches the v3 doc, never overwrites editor edits). See
"Blocks contract v2" below.

## Routes

### Admin Routes (protected by indiekit session auth)

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| GET | `/site-config/` | identity.get | Redirect to identity tab |
| GET | `/site-config/identity` | identity.get | Site identity form |
| POST | `/site-config/identity/save` | identity.save | Save identity (also `maybeSeedFromEnv` during first boot) |
| GET | `/site-config/branding` | branding.get | Branding form with live preview |
| POST | `/site-config/branding/save` | branding.save | Save branding, write `theme.css` + `critical.css` |
| GET | `/site-config/branding/preset` | branding.preset | Load preset palette |
| POST | `/site-config/branding/reset` | branding.reset | Reset to defaults |
| GET | `/site-config/branding/history` | branding.history | List last 10 saves |
| GET | `/site-config/homepage` | homepage.get | Homepage builder form |
| POST | `/site-config/homepage/save` | homepage.save | Save homepage config, write `homepage.json` |
| GET | `/site-config/blog` | blog.get | Blog settings form |
| POST | `/site-config/blog/save` | blog.save | Save blog config |
| GET | `/site-config/navigation` | navigation.get | Navigation editor form |
| POST | `/site-config/navigation/save` | navigation.save | Save navigation |
| GET | `/site-config/general` | general.get | General settings form |
| POST | `/site-config/general/save` | general.save | Save general settings |

### Public API Routes

All mounted under `/site-config/api`, no authentication required:

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| GET | `/api/preview` | api.preview | Render theme.css with pending form state (via query params) |
| GET | `/api/sections` | api.sections | List available homepage sections (discovered from plugins) |
| GET | `/api/widgets` | api.widgets | List available homepage widgets (discovered from plugins) |
| GET | `/api/blog-widgets` | api.blogWidgets | List available blog post widgets (discovered from plugins) |
| GET | `/api/homepage.json` | api.homepageJson | Render homepage.json with current config |

These endpoints power:
- Live preview in the branding tab (query-param driven)
- Homepage/blog builder dynamic section discovery
- Theme integration (Eleventy shortcodes reading `homepage.json`)

## Plugin Discovery

At init time (after all plugins load), `scanPlugins()` iterates over
`Indiekit.endpoints` and collects plugins that declare:

- **`homepageSections`** — array of `{ id, label }` objects (e.g., CV plugin offers "cv-experience", "cv-skills", etc.)
- **`homepageWidgets`** — array of widgets to display alongside sections
- **`blogPostWidgets`** — widgets for individual blog posts

These are cached and exposed via `/api/sections`, `/api/widgets`, `/api/blog-widgets`
so the admin UI can dynamically offer them without hard-coding a plugin list.

Example (CV endpoint):

```javascript
export class CvEndpoint {
  get homepageSections() {
    return [
      { id: "cv-experience", label: "Work Experience" },
      { id: "cv-skills", label: "Skills" },
      { id: "cv-education", label: "Education" },
      // ...
    ];
  }
}
```

The homepage builder can then enable/disable each section, reorder them, and
the theme reads `homepage.json` to render them.

### Blocks contract v2 (Phase 2)

Plugins can also declare a `get blocks()` getter — the v2 contract (id,
version, label, placement, data source, frozen JSON Schema subset, …). These
entries feed the block catalog (`block-catalog.json` artifact) and the v4
composition system; legacy getter entries are synthesized into catalog
entries when no `blocks` declaration exists. See "Blocks contract v2
(Phase 2)" in `README.md` for the full contract.

## File Outputs

On save, this plugin writes artifacts to `/app/data/content/_data/`:

1. **`theme.css`** — CSS custom properties for all palette tiers + semantic tokens, with `@media (prefers-color-scheme: dark)` blocks
2. **`critical.css`** — Above-the-fold CSS (inlined in `<head>` by theme's `base.njk`)
3. **`site-config.json`** — Structured config (identity, branding mode, etc.) consumed by `_data/site.js`
4. **`homepage.json`** — Homepage builder state (sections, widgets, hero) consumed by Eleventy shortcodes

## Environment Variables

**Seed from env (first boot only):**

- `SITE_NAME` — falls back to identity.name
- `SITE_DOMAIN` — falls back to identity.domain
- `SITE_AUTHOR` — falls back to identity.author
- `SITE_LANGUAGE` — falls back to identity.language

If `/site-config/identity/save` is called without these in the form, the
controller uses these env vars as defaults.

**For rendering:**

- `INDIEKIT_CONTENT_DIR` (or config option) — base path for content writes (default: `/app/data/content`)

## Key Patterns

### Color Tokens: Three-Tier System

1. **Reference (palette)** — OKLCH color scales, e.g., `--c-accent-50`, `--c-accent-950`
2. **Semantic (roles)** — What templates actually use, e.g., `--c-bg`, `--c-fg`, `--c-heading`, `--c-link`, `--c-action`
3. **Alert states** — Fixed for accessibility: `--c-success`, `--c-warning`, `--c-danger` (+ `-fg` variants)

Admins override Tier 2 roles; Tier 1 scales are derived automatically from the palette.

### Homepage Sections vs. Widgets

- **Sections** — full-width content blocks (e.g., CV experience, latest posts, portfolio grid)
- **Widgets** — sidebars or smaller callouts (e.g., "Featured on", "Latest video", social links)

Both are discovered from plugins, cached at init, and exposed to the theme
and admin UI via API.

### APCA Lc Contrast Validation

When a semantic token is saved, the `apca-w3` library calculates Lc contrast:

- **Lc < 30** — hard block (returns error form to user)
- **Lc < 45** — soft warning (user can still save but is warned)
- **Lc >= 45** — pass (standard WCAG AA equivalent)

This prevents admins from accidentally creating illegible color combinations.

## Provenance

**ORIGINAL plugin** — no upstream `@indiekit/endpoint-site-config` exists. This
is a custom `@rmdes/*` plugin that absorbed/replaced an earlier
`@indiekit/endpoint-homepage` and added branding + identity management.

## Testing

Run `npm test`. Uses Node's built-in test runner. Coverage includes:

- Schema validation (version 3 structure)
- Storage operations (MongoDB CRUD)
- Palette derivation (OKLCH scaling)
- Semantic color resolution (Tier 2 from Tier 1)
- APCA contrast validation
- History snapshotting and revert
- Reset paths (per-section + global)
- Form parsing (arrays, JSON strings)
- Plugin discovery (mocking endpoint registration)
- API endpoints (preview, sections, widgets, homepage.json)

## Related Documentation

- **Theme integration:** `indiekit-eleventy-theme` (reads `theme.css`, `critical.css`, `site-config.json`, `homepage.json`)
- **Plugin discovery:** Any plugin can declare `homepageSections`, `homepageWidgets`, `blogPostWidgets` to integrate with the homepage builder
- **Design spec:** `documentation-central/plans/2026-05-24-theming-v2-design.md`
