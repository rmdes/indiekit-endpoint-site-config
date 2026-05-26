import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidUrl, isValidEmail, isValidLocale, isValidCategoriesList,
  normalizeCategoriesInput,
} from "../lib/validators/identity.js";

test("isValidUrl accepts http(s) URLs", () => {
  assert.equal(isValidUrl("https://example.com"), true);
  assert.equal(isValidUrl("http://example.com/path?q=1"), true);
});

test("isValidUrl rejects invalid", () => {
  assert.equal(isValidUrl(""), false);
  assert.equal(isValidUrl("javascript:alert(1)"), false);
  assert.equal(isValidUrl("ftp://x.com"), false);
  assert.equal(isValidUrl("not a url"), false);
});

test("isValidUrl accepts empty string when allowEmpty=true", () => {
  assert.equal(isValidUrl("", { allowEmpty: true }), true);
});

test("isValidEmail accepts simple addresses", () => {
  assert.equal(isValidEmail("a@b.co"), true);
  assert.equal(isValidEmail("rick+test@example.com"), true);
});

test("isValidEmail rejects malformed", () => {
  assert.equal(isValidEmail("notanemail"), false);
  assert.equal(isValidEmail("a@"), false);
  assert.equal(isValidEmail("@b.co"), false);
});

test("isValidEmail accepts empty when allowEmpty=true", () => {
  assert.equal(isValidEmail("", { allowEmpty: true }), true);
});

test("isValidLocale accepts ISO 639-1 + optional region", () => {
  assert.equal(isValidLocale("en"), true);
  assert.equal(isValidLocale("en-GB"), true);
  assert.equal(isValidLocale("fr"), true);
});

test("isValidLocale rejects malformed", () => {
  assert.equal(isValidLocale("english"), false);
  assert.equal(isValidLocale("en_GB"), false);
  assert.equal(isValidLocale(""), false);
});

test("normalizeCategoriesInput splits CSV strings to array", () => {
  const result = normalizeCategoriesInput("indieweb, brussels , devops");
  assert.deepEqual(result, ["indieweb", "brussels", "devops"]);
});

test("normalizeCategoriesInput preserves array input", () => {
  const result = normalizeCategoriesInput(["a", "b"]);
  assert.deepEqual(result, ["a", "b"]);
});

test("normalizeCategoriesInput drops empty entries", () => {
  const result = normalizeCategoriesInput(", a, ,b ,");
  assert.deepEqual(result, ["a", "b"]);
});

test("isValidCategoriesList accepts array of short strings", () => {
  assert.equal(isValidCategoriesList(["a", "b", "c"]), true);
  assert.equal(isValidCategoriesList([]), true);
});

test("isValidCategoriesList rejects non-array or long entries", () => {
  assert.equal(isValidCategoriesList("not array"), false);
  assert.equal(isValidCategoriesList(["a".repeat(101)]), false); // too long
});
