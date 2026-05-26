import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNavigationBody } from "../lib/controllers/navigation.js";

test("parseNavigationBody zips parallel arrays into objects", () => {
  const body = {
    navLabel: ["Home", "About", "Blog"],
    navUrl:   ["/", "/about", "/blog"],
  };
  const result = parseNavigationBody(body);
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items[1], { label: "About", url: "/about", external: false });
});

test("parseNavigationBody trims empty trailing rows", () => {
  const body = {
    navLabel: ["Home", "", ""],
    navUrl:   ["/",    "", ""],
  };
  const result = parseNavigationBody(body);
  assert.equal(result.items.length, 1);
});

test("parseNavigationBody marks external URLs", () => {
  const body = {
    navLabel: ["GitHub"],
    navUrl:   ["https://github.com/rmdes"],
  };
  const result = parseNavigationBody(body);
  assert.equal(result.items[0].external, true);
});

test("parseNavigationBody handles single-row case (string not array)", () => {
  const body = { navLabel: "Solo", navUrl: "/" };
  const result = parseNavigationBody(body);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].label, "Solo");
});

test("parseNavigationBody returns empty items for empty body", () => {
  assert.deepEqual(parseNavigationBody({}), { items: [] });
});
