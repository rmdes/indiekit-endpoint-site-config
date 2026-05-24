# @rmdes/indiekit-endpoint-site-config

Site identity, branding, layout, and feature-flag configuration endpoint for [Indiekit](https://getindiekit.com).

Provides an admin UI for configuring a multi-tenant Indiekit deployment from a single canonical theme. Runtime CSS generation lets operators customize colors, typography, and layout without redeploying the theme.

## Status

`1.0.0-alpha.7` — usable, in production on [rmendes.net](https://rmendes.net). API may still shift before `1.0.0`.

## Features

- **12-control admin UI** for site theming (palette presets, semantic role overrides, mode preference)
- **Runtime CSS generation** — writes `theme.css` and `critical.css` to disk on each save; Eleventy picks them up via `inlineFile` filter on next rebuild
- **APCA Lc contrast validation** — blocks saves with unreadable color combinations (Lc < 30 hard, < 45 warn)
- **Version history** — last 10 saves snapshot to MongoDB; one-click revert
- **Reset per-section + global** — undo any subsection or all branding back to defaults
- **Live preview iframe** — pending form state previewed before save via query-param-driven endpoint
- **Mode-aware preview toggle** — preview light or dark mode independently of OS preference

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

- MongoDB collection: `siteConfig`
- Document `_id`: `"primary"` (singleton per deployment)
- Schema version: `2` (Path D, Phase 2a+)

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

Currently 159 tests covering schema, storage, palette derivation, semantic resolution, contrast validation, history snapshotting, reset paths, and form parsing.

## Dependencies

- `apca-w3` + `colorparsley` — APCA Lc contrast calculation
- `culori` — OKLCH palette derivation
- `@indiekit/error`, `@indiekit/frontend`, `express@^5`

## Development

This plugin is developed inside the [Indiekit development workspace](https://github.com/rmdes/indiekit-dev). The design spec lives at `documentation-central/plans/2026-05-24-theming-v2-design.md` in that workspace.

## License

MIT
