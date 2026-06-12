import { test } from "node:test";
import assert from "node:assert/strict";
import { validateComposition } from "../lib/validators/composition.js";

const CATALOG = [
  { id: "hero", multiple: false, schema: { type: "object", additionalProperties: false, properties: {
      showSocial: { type: "boolean", default: true } } } },
  { id: "recent-posts", multiple: true, schema: { type: "object", additionalProperties: false, properties: {
      maxItems: { type: "integer", minimum: 1, maximum: 50, default: 10 } } } },
  { id: "custom-html", multiple: true, schema: { type: "object", additionalProperties: false, properties: {
      content: { type: "string", maxLength: 20000 } } } },
];

const GOOD = {
  _id: "homepage", schemaVersion: 4, kind: "homepage", status: "published",
  tree: { block: "container", as: "stack", role: "root", children: [
    { block: "section", id: "b_hero1", type: "hero", v: 1, config: {} },
    { block: "container", as: "columns", role: "main",
      variant: { width: "default", columns: "2-1", gap: "loose" },
      children: [
        { block: "section", id: "b_rp1", type: "recent-posts", v: 1, config: { maxItems: 10 } },
      ] },
  ] },
};

test("accepts a valid composition and echoes a normalized value", () => {
  const result = validateComposition(GOOD, CATALOG);
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("drops unknown variant tokens with a warning, keeps valid ones", () => {
  const doc = structuredClone(GOOD);
  doc.tree.children[1].variant = { width: "huge", gap: "loose", glitter: true };
  const result = validateComposition(doc, CATALOG);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => /width/.test(w)));
  assert.deepEqual(result.value.tree.children[1].variant, { gap: "loose" });
});

test("errors: unknown block type, bad role, bad kind, missing section id, schemaVersion", () => {
  for (const [mutate, pattern] of [
    [(d) => { d.tree.children[0].type = "not-in-catalog"; }, /unknown block type/],
    [(d) => { d.tree.role = "navigation"; }, /role/],
    [(d) => { d.kind = "snowflake"; }, /kind/],
    [(d) => { delete d.tree.children[0].id; }, /section\.id/],
    [(d) => { d.schemaVersion = 3; }, /schemaVersion/],
  ]) {
    const doc = structuredClone(GOOD);
    mutate(doc);
    const result = validateComposition(doc, CATALOG);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => pattern.test(e)),
      `expected an error matching ${pattern}, got: ${result.errors.join("; ")}`,
    );
  }
});

test("config is validated against the catalog schema (stripUnknown surfaces warnings)", () => {
  const doc = structuredClone(GOOD);
  doc.tree.children[1].children[0].config = { maxItems: 999 };
  assert.equal(validateComposition(doc, CATALOG).ok, false); // above maximum

  const doc2 = structuredClone(GOOD);
  doc2.tree.children[1].children[0].config = { maxItems: 5, legacyKey: 1 };
  const lenient = validateComposition(doc2, CATALOG, { stripUnknown: true });
  assert.equal(lenient.ok, true);
  assert.ok(lenient.warnings.some((w) => /legacyKey/.test(w)));
});

test("caps: >24 sections, >1 hero (multiple:false), >3 custom-html all error", () => {
  const many = (n, type) => Array.from({ length: n }, (_, i) =>
    ({ block: "section", id: `b_${type}${i}`, type, v: 1, config: {} }));
  const wrap = (children) => ({ ...structuredClone(GOOD),
    tree: { block: "container", as: "stack", role: "root", children } });
  assert.equal(validateComposition(wrap(many(25, "recent-posts")), CATALOG).ok, false);
  assert.equal(validateComposition(wrap(many(2, "hero")), CATALOG).ok, false);
  assert.equal(validateComposition(wrap(many(4, "custom-html")), CATALOG).ok, false);
});

test("duplicate section ids in one tree error", () => {
  const doc = structuredClone(GOOD);
  doc.tree.children[1].children.push({ block: "section", id: "b_hero1", type: "recent-posts", v: 1, config: {} });
  assert.equal(validateComposition(doc, CATALOG).ok, false);
});

// --- Beyond the plan-mandated tests ---

test("value carries materialized schema defaults; input doc is never mutated", () => {
  const doc = structuredClone(GOOD);
  const result = validateComposition(doc, CATALOG);
  assert.equal(result.ok, true);
  // hero config {} → default showSocial: true materialized into value only
  assert.deepEqual(result.value.tree.children[0].config, { showSocial: true });
  // gate-not-transformer: the INPUT keeps its raw config (Task 7 persists raw)
  assert.deepEqual(doc.tree.children[0].config, {});
  assert.deepEqual(doc, GOOD);
});

test("max-depth guard: hostile deeply nested tree errors instead of blowing the stack", () => {
  let tree = { block: "section", id: "b_deep", type: "recent-posts", v: 1, config: {} };
  for (let i = 0; i < 100; i++) {
    tree = { block: "container", as: "stack", role: "region", children: [tree] };
  }
  tree.role = "root";
  const result = validateComposition(
    { schemaVersion: 4, kind: "homepage", tree }, CATALOG);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /depth/i.test(e)));
});

test("hero as a deep container child is structurally valid (placement legality is Phase 4)", () => {
  const doc = {
    schemaVersion: 4, kind: "homepage",
    tree: { block: "container", as: "stack", role: "root", children: [
      { block: "container", as: "grid", role: "main", children: [
        { block: "container", as: "stack", role: "region", children: [
          { block: "section", id: "b_hero1", type: "hero", v: 1, config: {} },
        ] },
      ] },
    ] },
  };
  const result = validateComposition(doc, CATALOG);
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("section variants keep block-level tokens, drop container-level tokens with warnings", () => {
  const doc = structuredClone(GOOD);
  doc.tree.children[0].variant = {
    surface: "card", listStyle: "list", align: "center",   // block-level → kept
    width: "wide", sticky: true,                            // container-level → dropped
  };
  const result = validateComposition(doc, CATALOG);
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.deepEqual(result.value.tree.children[0].variant,
    { surface: "card", listStyle: "list", align: "center" });
  assert.ok(result.warnings.some((w) => /width/.test(w)));
  assert.ok(result.warnings.some((w) => /sticky/.test(w)));
});

test("container variants drop block-level tokens with warnings", () => {
  const doc = structuredClone(GOOD);
  doc.tree.children[1].variant = { surface: "card", gap: "tight", sticky: true };
  const result = validateComposition(doc, CATALOG);
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.deepEqual(result.value.tree.children[1].variant, { gap: "tight", sticky: true });
  assert.ok(result.warnings.some((w) => /surface/.test(w)));
});

test("variant of wrong value type is dropped (sticky must be boolean, span from closed set)", () => {
  const doc = structuredClone(GOOD);
  doc.tree.children[1].variant = { sticky: "yes", span: 5, gap: "normal" };
  const result = validateComposition(doc, CATALOG);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.tree.children[1].variant, { gap: "normal" });
  assert.ok(result.warnings.some((w) => /sticky/.test(w)));
  assert.ok(result.warnings.some((w) => /span/.test(w)));
});

test("non-object variant is dropped with a warning; absent variant stays silent", () => {
  for (const bad of ["wide", ["wide"]]) {
    const doc = structuredClone(GOOD);
    doc.tree.children[1].variant = bad;
    const result = validateComposition(doc, CATALOG);
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.ok(result.warnings.some((w) => /non-object variant/.test(w)));
    assert.equal(Object.hasOwn(result.value.tree.children[1], "variant"), false);
  }
  const doc = structuredClone(GOOD);
  delete doc.tree.children[1].variant;
  const result = validateComposition(doc, CATALOG);
  assert.equal(result.ok, true);
  assert.ok(!result.warnings.some((w) => /variant/.test(w)));
});

test("variant filtered to nothing is omitted from the normalized node", () => {
  const doc = structuredClone(GOOD);
  doc.tree.children[1].variant = { glitter: true };
  const result = validateComposition(doc, CATALOG);
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.value.tree.children[1], "variant"), false);
});

test("invalid status errors; absent status is fine", () => {
  const doc = structuredClone(GOOD);
  doc.status = "archived";
  assert.equal(validateComposition(doc, CATALOG).ok, false);
  const doc2 = structuredClone(GOOD);
  delete doc2.status;
  assert.equal(validateComposition(doc2, CATALOG).ok, true);
});

test("throw-free on hostile plain-data input", () => {
  // non-object docs
  for (const doc of [null, undefined, 42, "tree", []]) {
    const result = validateComposition(doc, CATALOG);
    assert.equal(result.ok, false);
  }
  // missing tree
  assert.equal(validateComposition({ schemaVersion: 4, kind: "homepage" }, CATALOG).ok, false);
  // garbage nodes, unknown node kind, hostile catalog entries, poisoned variant keys
  const doc = {
    schemaVersion: 4, kind: "homepage",
    tree: { block: "container", as: "stack", role: "root",
      variant: JSON.parse('{"__proto__": {"polluted": true}, "constructor": "x", "gap": "tight"}'),
      children: [
        null, 42, "section", { block: "widget" },
        { block: "section", id: "b_ok", type: "recent-posts", v: 1, config: null },
      ] },
  };
  const hostileCatalog = [null, 42, { noId: true }, ...CATALOG];
  const result = validateComposition(doc, hostileCatalog);
  assert.equal(result.ok, false); // garbage children are structural errors
  assert.deepEqual(result.value.tree.variant, { gap: "tight" });
  assert.equal({}.polluted, undefined);
  // null config degrades to {} (block-schema contract), no throw
  assert.ok(result.errors.some((e) => /widget/.test(e)));
});

test("present non-array children is a structural error; absent children is a valid empty container", () => {
  // PRESENT corrupted children is a structural problem, not an empty layout…
  const doc = {
    schemaVersion: 4, kind: "homepage",
    tree: { block: "container", as: "stack", role: "root", children: "oops" },
  };
  const result = validateComposition(doc, CATALOG);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /children/.test(e)));
});

test("a container with no children key is a legitimate empty container", () => {
  const childless = {
    schemaVersion: 4, kind: "homepage",
    tree: { block: "container", as: "stack", role: "root" },
  };
  const result = validateComposition(childless, CATALOG);
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.deepEqual(result.value.tree.children, []);
});
