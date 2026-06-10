# @rmdes/indiekit-endpoint-site-config

Site identity, branding, layout, and feature-flag configuration endpoint for [Indiekit](https://getindiekit.com).

Provides an admin UI for configuring a multi-tenant Indiekit deployment from a single canonical theme. Runtime CSS generation lets operators customize colors, typography, and layout without redeploying the theme.

## Status

Stable, in production. See `package.json` for version. Core tier plugin in `indiekit-cloudron` (cannot be disabled per-site).

## Features

- **Admin UI** (tabs: identity, branding, homepage, blog, navigation, general)
  - Identity: name, domain, author, language
  - Branding: 12-control theming (palette presets, semantic role overrides, mode preference)
  - Homepage: hero, layout, featured sections from plugins, widget discovery
  - Blog: post listing config, pagination
  - Navigation: menu items, site structure
  - General: publication settings
- **Runtime CSS generation** — writes `theme.css` and `critical.css` to disk on each save; Eleventy picks them up via `inlineFile` filter on next rebuild
- **APCA Lc contrast validation** — blocks saves with unreadable color combinations (Lc < 30 hard, < 45 warn)
- **Version history** — last 10 saves snapshot to MongoDB; one-click revert
- **Reset per-section + global** — undo any subsection or all branding back to defaults
- **Live preview iframe** — pending form state previewed before save via query-param-driven endpoint
- **Mode-aware preview toggle** — preview light or dark mode independently of OS preference
- **Plugin discovery** — scans registered plugins for `homepageSections`, `homepageWidgets`, `blogPostWidgets`; exposes them via public API for UI composition

## Architecture — 3-Tier Token System

| Tier | What | Examples |
|------|------|----------|
| **1. Reference (palette)** | Derived OKLCH-based color scales | `--c-surface-50..950`, `--c-accent-50..950` |
| **2. Semantic (roles)** | What templates actually USE | `--c-bg`, `--c-fg`, `--c-fg-muted`, `--c-heading`, `--c-link`, `--c-action`, `--c-action-fg`, `--c-surface`, `--c-border`, `--c-focus` |
| **3. Alert states** | Fixed for accessibility | `--c-success`, `--c-warning`, `--c-danger` (with `-fg` variants) |

Templates reference Tier 2 utility classes (`text-heading`, `bg-action`, `border-border`, etc.). When the admin saves a role override, only that semantic token changes — every template element bound to that role updates within one Eleventy rebuild cycle.

This mirrors the established CMS pattern documented by [WordPress theme.json](https://developer.wordpress.org/themes/global-settings-and-styles/), [Material Design 3](https://m3.material.io/styles/color/system/overview), and [W3C Design Tokens Community Group](https://design-tokens.github.io/community-group/format/).

## Installation

```bash
npm install @rmdes/indiekit-endpoint-site-config
```

## Configuration

In your `indiekit.config.js`:

```js
import SiteConfigEndpoint from "@rmdes/indiekit-endpoint-site-config";

export default {
  plugins: [
    new SiteConfigEndpoint({
      mountPath: "/site-config",  // default
    }),
    // ... other plugins
  ],
};
```

## Storage

Two MongoDB collections:

1. **`siteConfig`** — singleton document `_id: "primary"` storing all site identity, branding, navigation, blog config (schema version 3)
2. **`homepageConfig`** — homepage builder state: hero, layout, sections, widgets (discovered from plugins at init() time)

## Routes

### Admin (Protected by Indiekit session)

| Path | Controller | Purpose |
|------|-----------|---------|
| `/site-config` | identity | Site name, domain, author, language |
| `/site-config/branding` | branding | Palette, semantic tokens, mode preferences, APCA validation |
| `/site-config/homepage` | homepage | Hero, layout, featured sections (from plugins), widgets |
| `/site-config/blog` | blog | Post listing config, pagination settings |
| `/site-config/navigation` | navigation | Menu items, navigation structure |
| `/site-config/general` | general | General publication settings |

### Public API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/preview` | Live preview of current form state (renders theme.css with pending changes) |
| GET | `/api/sections` | List of available homepage sections (discovered from registered plugins) |
| GET | `/api/widgets` | List of available homepage widgets (discovered from plugins) |
| GET | `/api/blog-widgets` | List of available blog post widgets (discovered from plugins) |
| GET | `/api/homepage.json` | Rendered homepage config (consumed by theme or client-side builds) |

These endpoints enable the theme's admin UI to offer live previews and dynamic plugin discovery without exposing sensitive config data.

## Theme integration

The companion Eleventy theme [`indiekit-eleventy-theme`](https://github.com/rmdes/indiekit-eleventy-theme) reads:
- `/app/data/content/_data/theme.css` (runtime CSS vars, via `inlineFile` filter in a `theme.css.njk` template)
- `/app/data/content/_data/critical.css` (per-site critical CSS for first paint)
- `/app/data/content/_data/site-config.json` (structured config for `_data/site.js`)

The theme's `tailwind.config.js` exposes Tier 2 utility classes (`text-heading`, `bg-action`, `border-border`, etc.) bound to the CSS variables this plugin emits.

## Mode handling

Three states: `light`, `dark`, `auto`. In `auto` mode the plugin emits both `@media (prefers-color-scheme: dark)` AND a `.dark` class block, with the `@media` rule scoped to `:root:not(.light)` so an explicit user override (via JS toggle adding `.light`) wins over OS preference.

## Testing

```bash
npm test
```

Run with Node's test runner. Coverage includes schema validation, storage operations, palette derivation, semantic color resolution, APCA contrast validation, history management, reset functionality, and form parsing.

## Dependencies

- `apca-w3` + `colorparsley` — APCA Lc contrast calculation
- `culori` — OKLCH palette derivation
- `@indiekit/error`, `@indiekit/frontend`, `express@^5`

## Plugin Origin

**ORIGINAL plugin** — no upstream `@indiekit/endpoint-site-config` equivalent. This is a custom `@rmdes/*` plugin created as the successor to (and replacement for) an earlier `@indiekit/endpoint-homepage`.

**Registry status:** Core tier in `indiekit-cloudron` — always installed, cannot be disabled per-site.

## Development

This plugin is developed inside the [Indiekit development workspace](https://github.com/rmdes/indiekit-dev). The design spec lives at `documentation-central/plans/2026-05-24-theming-v2-design.md` in that workspace.

## License

MIT
