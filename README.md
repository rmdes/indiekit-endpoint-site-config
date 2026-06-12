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

Three MongoDB collections:

1. **`siteConfig`** — singleton document `_id: "primary"` storing all site identity, branding, navigation, blog config (schema version 3)
2. **`homepageConfig`** — homepage builder state: hero, layout, sections, widgets (discovered from plugins at init() time)
3. **`compositions`** — site-builder v4 composition documents (schema version 4), seeded by the dual-running v3 → v4 migration (see [Blocks contract v2](#blocks-contract-v2-phase-2) below)

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

## Blocks contract v2 (Phase 2)

Phase 2 of the site builder introduces a unified **block catalog**: one validated registry of every block a site can place — built-ins, legacy plugin getters, and the new plugin-declared blocks — serialized to disk for the theme.

### Declaring blocks (`get blocks()`)

Any registered plugin can declare blocks via a `blocks` getter:

```js
export default class GithubEndpoint {
  get blocks() {
    return [{
      id: "github-repos",
      version: 1,
      label: "GitHub Projects",
      description: "Repos and commits",
      icon: "github",
      category: "social",
      placement: { regions: ["sidebar", "main"], surfaces: ["homepage", "collection"] },
      multiple: true,
      schema: { type: "object", additionalProperties: false, properties: { /* frozen JSON Schema subset */ } },
      data: { source: "api" },
    }];
  }
}
```

Each entry passes a strict gate at discovery time: flat kebab-case `id`, integer `version >= 1`, non-empty `label`, `placement.regions` a non-empty subset of `main|sidebar|footer|hero`, optional `placement.surfaces` a subset of `homepage|collection|postType|standalone`, a valid `data` declaration, and a `schema` in the frozen subset below. Invalid entries are skipped with a console warning — discovery never crashes on a bad plugin.

### Frozen JSON Schema subset

Block config schemas use a deliberately tiny subset of JSON Schema 2020-12. Anything outside the subset is **rejected at registration**, so the admin form generator, save-time validation, and the migrator all share the exact same semantics.

| Allowed | Values |
|---------|--------|
| Property types | `string`, `integer`, `number`, `boolean`, `array` (of strings only — `items: { type: "string" }` exactly) |
| Property keywords | `type`, `enum`, `default`, `minimum`, `maximum`, `maxLength`, `title`, `description`, `items`, `x-control`, `x-advanced` |
| Top-level keywords | `type: "object"`, `additionalProperties: false` (**mandatory**), `properties`, `required` |
| `x-control` | `textarea`, `markdown`, `color`, `post-type-picker` |
| `x-advanced` | boolean — marks a field for the editor's "advanced" disclosure |

Gotchas the validator enforces:

- **Defaults are validated against their own constraints** — a `default` that violates its property's `enum`/`minimum`/`maximum`/`maxLength` is rejected at registration.
- **`required` means explicitly provided** — defaults never satisfy `required`. Declaring both `required` and a `default` on the same property means an empty config can never validate; don't combine them.
- **Reserved property names** `__proto__`, `constructor`, and `prototype` are rejected (prototype-pollution guard).

### Data sources

| `data.source` | Meaning | Required fields |
|---------------|---------|-----------------|
| `file` | Block reads a JSON data file | `data.file` |
| `collections` | Block reads an Eleventy collection | `data.key` |
| `config` | Block renders from its config alone | — |
| `api` | Block data is fetched from a plugin API | — |

### Legacy back-compat

The three legacy getters (`homepageSections`, `homepageWidgets`, `blogPostWidgets`) keep working unchanged. The scanner synthesizes catalog entries from them, marked `legacy: true` with `version: 0`; legacy entries keep bespoke-template semantics (the theme renders them via their existing partials, never the generic renderers). Per-id precedence, higher wins: built-in < legacy synthesis < plugin `blocks` declaration — a `blocks` entry shadows a same-id legacy or built-in entry.

### block-catalog.json artifact

After plugin discovery, the catalog is written **atomically** (tmp file + rename, so the Eleventy watcher never sees a partial file) to:

```
/app/data/content/_data/block-catalog.json
```

Shape: `{ catalogVersion: 1, generatedAt: "<ISO timestamp>", blocks: [...] }`, with blocks sorted by id and restricted to a whitelisted public field set. Each block carries `requiresPlugin`: `null` for built-ins (always available) or the registering endpoint's name — from Phase 3 the theme maps this to its `loadedPlugins` gating. The artifact is inert in Phase 2; the theme starts consuming it in Phase 3.

### Dual-running v3 → v4 migration

On boot, after discovery, v4 composition documents are computed from the v3 `homepageConfig` doc and seeded into the `compositions` collection — the homepage plus the two default sidebar surfaces (`collection:default`, `posttype:default`). The migration is **seed-if-absent**: it never modifies the v3 doc and never overwrites an existing composition, so it is safe on every boot and editor edits survive re-runs. v3 remains the source of truth (the legacy admin UI and `homepage.json` still own it) until the Phase 3 cutover.

Diagnostics:

- **Boot log** — look for `[site-config] v4 migration: seeded=[…] existing=[…] valid=true` (or `no v3 source, skipped`)
- **`GET /site-config/api/migration-preview`** (authenticated admin API) — recomputes the migration as a dry run on every request and responds `{ docs, report, existing }`; it never writes

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
