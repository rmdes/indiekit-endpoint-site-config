import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import nunjucks from "nunjucks";
import i18nPackage from "i18n";

const { I18n } = i18nPackage;

// Regression for the eaten-placeholder bug (beta.14 → beta.15): the i18n
// package interpolates {{var}} at template render time with mustache
// semantics, so a missing variable becomes an EMPTY string. Locale strings
// whose placeholders are replaced CLIENT-side by editor.js
// (.replace("{{seconds}}", …) / .replace("{{time}}", …)) must be passed
// through __() with the placeholder mapped to itself, e.g.
// __("…previewPane.building", { seconds: "{{seconds}}" }).
//
// This test renders the REAL editorI18n expression extracted from
// views/site-config-design-homepage.njk through real nunjucks with the real
// i18n package over the shipped locale catalogs, then asserts every
// placeholder present in the catalog string survives into the client JSON.

const here = path.dirname(fileURLToPath(import.meta.url));
const viewPath = path.join(here, "../views/site-config-design-homepage.njk");
const localesDir = path.join(here, "../locales");
const LOCALES = ["en", "fr"];

const viewSource = readFileSync(viewPath, "utf8");
const setMatch = viewSource.match(/\{% set editorI18n = (\{[\s\S]*?\}) %\}/);

// jsonKey → __() locale key, taken from the actual expression
const i18nCalls = setMatch
  ? [...setMatch[1].matchAll(/(\w+):\s*__\("([^"]+)"/g)].map((m) => ({
      jsonKey: m[1],
      localeKey: m[2],
    }))
  : [];

const lookupCatalog = (locale, dottedKey) => {
  const catalog = JSON.parse(
    readFileSync(path.join(localesDir, `${locale}.json`), "utf8"),
  );
  return dottedKey
    .split(".")
    .reduce((node, part) => (node ? node[part] : undefined), catalog);
};

const renderEditorI18n = (locale) => {
  const i18n = new I18n({
    locales: LOCALES,
    directory: localesDir,
    objectNotation: true,
    updateFiles: false,
    defaultLocale: locale,
  });
  const env = new nunjucks.Environment(null, { autoescape: true });
  const template = `{% set editorI18n = ${setMatch[1]} %}{{ editorI18n | dump | safe }}`;
  const rendered = env.renderString(template, {
    __: (phrase, args) => i18n.__({ phrase, locale }, args),
  });
  return JSON.parse(rendered);
};

test("view defines the sc-editor-i18n JSON block", () => {
  assert.ok(setMatch, "editorI18n {% set %} expression found in the view");
  assert.ok(i18nCalls.length > 0, "editorI18n contains __() calls");
  assert.ok(viewSource.includes('id="sc-editor-i18n"'));
});

for (const locale of LOCALES) {
  test(`client i18n JSON preserves {{seconds}}/{{time}} placeholders (${locale})`, () => {
    const parsed = renderEditorI18n(locale);

    // The three strings editor.js post-processes client-side
    assert.ok(
      parsed.previewBuilding.includes("{{seconds}}"),
      `previewBuilding keeps {{seconds}}: ${parsed.previewBuilding}`,
    );
    assert.ok(
      parsed.buildBuilding.includes("{{seconds}}"),
      `buildBuilding keeps {{seconds}}: ${parsed.buildBuilding}`,
    );
    assert.ok(
      parsed.buildLive.includes("{{time}}"),
      `buildLive keeps {{time}}: ${parsed.buildLive}`,
    );
  });

  test(`every client-consumed catalog placeholder survives rendering (${locale})`, () => {
    const parsed = renderEditorI18n(locale);
    for (const { jsonKey, localeKey } of i18nCalls) {
      const catalogString = lookupCatalog(locale, localeKey);
      assert.equal(
        typeof catalogString,
        "string",
        `${locale} catalog has ${localeKey}`,
      );
      for (const [placeholder] of catalogString.matchAll(/\{\{\w+\}\}/g)) {
        assert.ok(
          parsed[jsonKey].includes(placeholder),
          `${jsonKey} (${localeKey}, ${locale}) keeps ${placeholder} — got: ${parsed[jsonKey]}`,
        );
      }
    }
  });
}

// #39 — the shared editor view is rendered for EVERY surface (homepage,
// listing, postType). Copy that hardcodes "homepage" leaks onto the other
// surfaces. The fix parameterises these strings with a {{surface}} noun
// supplied per-surface via __(editorNounKey). These tests guard that (a) the
// noun catalog exists in every locale, (b) the shared strings are
// surface-parameterised (contain {{surface}}, not a hardcoded surface noun),
// and (c) interpolation resolves to clean copy with no eaten placeholder.
const SHARED_SURFACE_KEYS = [
  "siteConfig.design.confirms.discard",
  "siteConfig.design.confirms.remove",
  "siteConfig.design.draftBar.live",
  "siteConfig.design.empty.explainer",
  "siteConfig.design.custom.notice",
  "siteConfig.design.errors.duplicate",
  "siteConfig.design.errors.no-composition",
  "siteConfig.design.errors.custom-tree",
];

// Hardcoded surface nouns that must NOT appear in the shared (surface-agnostic)
// strings — per locale. Their presence means the string still leaks.
const LEAKED_NOUN = { en: "homepage", fr: "page d'accueil" };

for (const locale of LOCALES) {
  test(`surfaceNoun catalog is complete (${locale})`, () => {
    for (const routeKey of ["homepage", "listing", "posttype"]) {
      const noun = lookupCatalog(
        locale,
        `siteConfig.design.editor.surfaceNoun.${routeKey}`,
      );
      assert.equal(typeof noun, "string", `${locale} surfaceNoun.${routeKey}`);
      assert.ok(noun.length > 0, `${locale} surfaceNoun.${routeKey} non-empty`);
    }
  });

  test(`shared editor strings are surface-parameterised, not homepage-hardcoded (${locale})`, () => {
    for (const key of SHARED_SURFACE_KEYS) {
      const str = lookupCatalog(locale, key);
      assert.equal(typeof str, "string", `${locale} has ${key}`);
      assert.ok(
        str.includes("{{surface}}"),
        `${key} (${locale}) uses {{surface}}: ${str}`,
      );
      assert.ok(
        !str.includes(LEAKED_NOUN[locale]),
        `${key} (${locale}) no longer hardcodes "${LEAKED_NOUN[locale]}": ${str}`,
      );
    }
  });

  test(`{{surface}} resolves server-side with no eaten placeholder (${locale})`, () => {
    const i18n = new I18n({
      locales: LOCALES,
      directory: localesDir,
      objectNotation: true,
      updateFiles: false,
      defaultLocale: locale,
    });
    const noun = i18n.__({
      phrase: "siteConfig.design.editor.surfaceNoun.posttype",
      locale,
    });
    const rendered = i18n.__(
      { phrase: "siteConfig.design.draftBar.live", locale },
      { surface: noun },
    );
    assert.ok(
      rendered.includes(noun),
      `${locale} draftBar.live carries the post-sidebar noun: ${rendered}`,
    );
    assert.ok(
      !rendered.includes("{{surface}}"),
      `${locale} draftBar.live has no leftover placeholder: ${rendered}`,
    );
    assert.ok(
      !rendered.includes(LEAKED_NOUN[locale]),
      `${locale} draftBar.live on postType does not say "${LEAKED_NOUN[locale]}": ${rendered}`,
    );
  });
}

// #40 — every locale must carry the SAME keys under siteConfig.design. A
// missing key in a non-default locale silently falls back to the key path (or
// English), e.g. the French listing/postType editor H1 showed a raw key. This
// parity guard fails loudly if en and a translated locale drift apart.
const flattenKeys = (obj, prefix = "") => {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flattenKeys(v, key));
    } else {
      keys.push(key);
    }
  }
  return keys;
};

const designNamespace = (locale) =>
  lookupCatalog(locale, "siteConfig.design");

test("every locale has the same siteConfig.design keys as en (no i18n gaps)", () => {
  const enKeys = new Set(flattenKeys(designNamespace("en")));
  for (const locale of LOCALES) {
    if (locale === "en") continue;
    const localeKeys = new Set(flattenKeys(designNamespace(locale)));
    const missing = [...enKeys].filter((k) => !localeKeys.has(k));
    assert.deepEqual(
      missing,
      [],
      `${locale}.json siteConfig.design is missing: ${missing.join(", ")}`,
    );
  }
});

test("i18n eats unmapped {{var}} placeholders (defect mechanism)", () => {
  // Documents WHY self-mapping is required: without args, mustache replaces
  // the missing variable with an empty string. If this ever stops holding,
  // the self-mapping workaround can be revisited.
  const i18n = new I18n({
    locales: LOCALES,
    directory: localesDir,
    objectNotation: true,
    updateFiles: false,
    defaultLocale: "fr",
  });
  const eaten = i18n.__({
    phrase: "siteConfig.design.previewPane.building",
    locale: "fr",
  });
  assert.ok(!eaten.includes("{{seconds}}"), `placeholder consumed: ${eaten}`);
});
