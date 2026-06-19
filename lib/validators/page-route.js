/**
 * Standalone-page route/slug DOUBLE-GUARD (Phase 6.5, D5 — SECURITY CRITICAL).
 *
 * A standalone page's `target.route` is operator-controlled input that becomes
 * BOTH a filesystem output path (Eleventy writes `/<route>/index.html`, and
 * silently OVERWRITES on a duplicate output path) AND a public URL. So the
 * slug/route is a security boundary: a bad value could overwrite another
 * page's output, escape the content tree via traversal, shadow an admin or
 * plugin route, or collide with real content.
 *
 * This module is the SAVE-TIME (create) leg of the double-guard. The SECOND,
 * independent leg lives in `validators/composition.js` (`target.route`/`title`
 * validation), which gates the PUBLISH path even if a save-time guard is
 * bypassed (defense in depth — two layers that never share state).
 *
 * Defensive posture (mirrors `config-url.js` and the composition validator):
 * - ANCHORED, ASCII-only kebab regex. No unicode, no homoglyphs, no
 *   zero-width, no control chars, no dots, no slashes, no traversal.
 * - validate-then-normalize: the slug is validated by the anchored regex
 *   BEFORE any `/<slug>/` string is constructed, so normalization can never
 *   re-introduce a rejected character.
 * - Reserved-prefix list = a hardcoded CORE list (the editor's own routes +
 *   known plugin/core mounts) PLUS the loaded-plugin mount prefixes derived
 *   from `Indiekit.endpoints` at request time. Reserved means a HARD reject.
 * - Collision legs (async, DB): reject when the route/slug collides with an
 *   existing `posts` doc url, or an existing `page:<slug>` composition.
 *
 * Authority of the reserved list (documented per the security review ask):
 *   CORE_RESERVED_PREFIXES is the floor — it names the editor's own surface
 *   routes (site-config, preview, api, plugins, status, session, assets) and
 *   the core Indiekit endpoints a page must never shadow (auth, micropub,
 *   microsub, media, image, files, posts). `reservedPrefixes(Indiekit)` UNIONS
 *   that floor with the FIRST PATH SEGMENT of every loaded endpoint's
 *   `mountPath`, so an operator can never mint a page at a slug that a loaded
 *   plugin already serves. The `content/pages/*.md` collision (operator slash
 *   pages) is intentionally NOT in this list — those are operator content and
 *   are caught at BUILD time by the theme loader filter (D5 build-time leg, T7).
 *
 * @module validators/page-route
 */

// Anchored, ASCII-only, lowercase kebab. Single segment: lowercase letters and
// digits, hyphen-separated, no leading/trailing/double hyphen, no underscore,
// no dot, no slash, no whitespace, no unicode. The anchors are the whole
// security guarantee against substring-match bypasses — asserted in tests.
export const PAGE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// A slug longer than this is rejected — a page route that long is never
// legitimate and an unbounded slug is needless attack surface (long output
// paths, log spam). 64 chars is generous for any real slug.
const MAX_SLUG_LENGTH = 64;

// Title cap: a human-facing page title. Bounded to keep the artifact small and
// avoid an unbounded string reaching the theme.
const MAX_TITLE_LENGTH = 120;

/**
 * The hardcoded CORE reserved prefixes — the floor of the reserved list. See
 * the module doc for the authority of this list. A page slug matching any of
 * these is a hard reject regardless of loaded plugins.
 */
export const CORE_RESERVED_PREFIXES = Object.freeze(
  new Set([
    // The editor's own + core surface routes a page must never shadow.
    "site-config",
    "preview",
    "api",
    "assets",
    "status",
    "plugins",
    "session",
    // Core Indiekit endpoint mounts (also re-derived at runtime, but pinned
    // here so the floor holds even if an endpoint mountPath getter throws).
    "auth",
    "micropub",
    "microsub",
    "media",
    "image",
    "files",
    "posts",
  ]),
);

/**
 * The first path segment of a mount path (`/bar/baz` becomes `bar`). A root
 * mount (`/` or empty) yields null — reserving "" would reject everything, so
 * a root-mounted endpoint contributes NO prefix.
 * @param {unknown} mountPath
 * @returns {string | null}
 */
function mountPrefix(mountPath) {
  if (typeof mountPath !== "string") return null;
  const seg = mountPath.replace(/^\/+/, "").split("/")[0];
  return seg ? seg.toLowerCase() : null;
}

/**
 * Build the effective reserved-prefix Set: CORE_RESERVED_PREFIXES unioned with
 * the first-segment mount prefix of every loaded endpoint. Throw-proof on a
 * poisoned `mountPath` getter (same posture as scan-plugins / endpointNames).
 *
 * @param {object | null | undefined} Indiekit Host (reads `Indiekit.endpoints`)
 * @returns {Set<string>}
 */
export function reservedPrefixes(Indiekit) {
  const reserved = new Set(CORE_RESERVED_PREFIXES);
  const endpoints = Indiekit?.endpoints;
  if (!endpoints) return reserved;
  for (const endpoint of endpoints) {
    try {
      const prefix = mountPrefix(endpoint?.mountPath);
      if (prefix) reserved.add(prefix);
    } catch {
      // Poisoned mountPath getter — skip it, keep the rest of the list intact.
    }
  }
  return reserved;
}

/**
 * Pure shape + reserved guard for a page route/slug. NO DB access — the
 * collision legs are `checkRouteCollision`. Accepts either a bare slug
 * (`about`) or an already-normalized single-segment route (`/about/`); both
 * normalize to `/<slug>/`. Validate-then-normalize: the regex runs on the
 * extracted slug BEFORE any route string is built.
 *
 * @param {unknown} input A slug (`about`) or normalized route (`/about/`)
 * @param {object} [context]
 * @param {Set<string>} [context.reservedPrefixes] Effective reserved set
 *   (from `reservedPrefixes(Indiekit)`). Absent uses CORE_RESERVED_PREFIXES.
 * @returns {{ ok: true, route: string, slug: string } | { ok: false, error: string }}
 */
export function validatePageRoute(input, context = {}) {
  if (typeof input !== "string") {
    return { ok: false, error: "route must be a string" };
  }
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: "route is required" };

  // Extract the slug. A normalized route must be EXACTLY `/<slug>/` — one
  // leading slash, one trailing slash, no interior slashes. Anything else
  // (bare slug, or malformed route) is handled by the regex below.
  let slug;
  if (trimmed.startsWith("/") || trimmed.endsWith("/")) {
    // Treat as a route form: require exactly one leading and one trailing
    // slash with a single segment between. `/a/b/`, `//a/`, `/a`, `a/` all
    // fail this and fall through to a reject (they won't match PAGE_SLUG).
    const m = /^\/([^/]+)\/$/.exec(trimmed);
    slug = m ? m[1] : trimmed; // non-matching route stays as-is so the regex rejects it
  } else {
    slug = trimmed;
  }

  if (slug.length > MAX_SLUG_LENGTH) {
    return { ok: false, error: "route is too long" };
  }
  if (!PAGE_SLUG.test(slug)) {
    return { ok: false, error: "route must be a lowercase single-segment slug" };
  }

  const reserved = context.reservedPrefixes ?? CORE_RESERVED_PREFIXES;
  if (reserved.has(slug)) {
    return { ok: false, error: `route "${slug}" is reserved` };
  }

  // validate-then-normalize: only a slug that PASSED the anchored regex ever
  // reaches the route construction, so `/${slug}/` is always safe.
  return { ok: true, route: `/${slug}/`, slug };
}

/**
 * Async collision legs (D5): reject when the slug/route collides with an
 * existing `posts` doc url, or an existing `page:<slug>` composition. Tolerant
 * when `db` is absent (no DB means no collision leg — the pure guard still
 * ran). The `content/pages/*.md` collision is the BUILD-TIME leg (theme
 * loader, T7); it is NOT checked here (cross-repo, operator content).
 *
 * @param {object | null | undefined} db Indiekit.database
 * @param {object | null | undefined} _Indiekit Reserved for future legs (kept
 *   for a stable signature with the create route)
 * @param {{ slug: string, route: string }} target Output of validatePageRoute
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function checkRouteCollision(db, _Indiekit, { slug, route }) {
  if (!db || typeof db.collection !== "function") return { ok: true };

  // (a) posts collection: a published post already owning this url. Match
  // either `properties.url` or the page-typed post-type url shape; an OR keeps
  // us robust to how a given post stores its canonical url.
  try {
    const posts = db.collection("posts");
    if (posts && typeof posts.findOne === "function") {
      const hit = await posts.findOne({
        $or: [
          { "properties.url": route },
          { "properties.url": `/${slug}` },
          { "properties.url": slug },
        ],
      });
      if (hit) {
        return { ok: false, error: `route "${route}" collides with an existing post` };
      }
    }
  } catch {
    // A failed query must not silently allow a collision through, but it also
    // must not crash the create flow. Surface a generic error so the operator
    // retries rather than minting a possibly-colliding page.
    return { ok: false, error: "could not verify route availability" };
  }

  // (b) compositions: another page:<slug> composition already exists.
  try {
    const compositions = db.collection("compositions");
    if (compositions && typeof compositions.findOne === "function") {
      const existing = await compositions.findOne({ _id: `page:${slug}` });
      if (existing) {
        return { ok: false, error: `a page at "${route}" already exists` };
      }
    }
  } catch {
    return { ok: false, error: "could not verify route availability" };
  }

  return { ok: true };
}

/**
 * The FULL save-time guard the create route (T3) calls: pure shape + reserved,
 * then the async collision legs. Short-circuits on the first failure.
 *
 * @param {unknown} input Slug or normalized route
 * @param {object} deps
 * @param {object | null | undefined} deps.db Indiekit.database
 * @param {object | null | undefined} deps.Indiekit Host (for reserved mounts)
 * @returns {Promise<{ ok: true, route: string, slug: string } | { ok: false, error: string }>}
 */
export async function guardPageRoute(input, { db, Indiekit } = {}) {
  const shape = validatePageRoute(input, { reservedPrefixes: reservedPrefixes(Indiekit) });
  if (!shape.ok) return shape;
  const collision = await checkRouteCollision(db, Indiekit, shape);
  if (!collision.ok) return collision;
  return shape;
}

/**
 * Validate a page `target` object (route + title) for the composition
 * validator's page-kind leg AND any callers needing the same shared shape.
 * This is the SECOND, independent guard layer (defense in depth): it rejects a
 * bad target on the PUBLISH path even if the save-time guard was bypassed.
 *
 * Pure + DB-free + reserved-free: the publish path is a gate over data already
 * persisted, so it checks SHAPE only (the save-time guard owns reserved +
 * collision). Title is required, non-empty (trimmed), length-capped.
 *
 * @param {unknown} target
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validatePageTarget(target) {
  const errors = [];
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return { ok: false, errors: ["target is required for a page (must be an object)"] };
  }
  const shape = validatePageRoute(target.route, { reservedPrefixes: new Set() });
  if (!shape.ok) {
    errors.push(`target.route invalid: ${shape.error}`);
  }
  const title = typeof target.title === "string" ? target.title.trim() : "";
  if (typeof target.title !== "string" || title === "") {
    errors.push("target.title is required (non-empty string)");
  } else if (target.title.length > MAX_TITLE_LENGTH) {
    errors.push(`target.title exceeds maximum length ${MAX_TITLE_LENGTH}`);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
