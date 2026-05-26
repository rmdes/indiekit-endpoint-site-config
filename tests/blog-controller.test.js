import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBlogBody } from "../lib/controllers/blog.js";

test("parseBlogBody extracts both blog sidebars", () => {
  const body = {
    blogListingSidebar: JSON.stringify([{ type: "search", config: {} }]),
    blogPostSidebar:    JSON.stringify([{ type: "toc", config: {} }, { type: "share", config: {} }]),
  };
  const result = parseBlogBody(body);
  assert.equal(result.blogListingSidebar.length, 1);
  assert.equal(result.blogPostSidebar.length, 2);
  assert.equal(result.blogPostSidebar[0].type, "toc");
});

test("parseBlogBody defaults to empty arrays on missing/invalid", () => {
  assert.deepEqual(parseBlogBody({}), { blogListingSidebar: [], blogPostSidebar: [] });
});
