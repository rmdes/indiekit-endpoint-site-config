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
