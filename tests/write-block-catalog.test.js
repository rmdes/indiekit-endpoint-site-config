import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBlockCatalogJson, renderBlockCatalog } from "../lib/render/write-block-catalog-json.js";
import { BUILTIN_BLOCKS } from "../lib/presets/builtin-blocks.js";

const ENTRY = {
  id: "z-block", version: 1, label: "Z", description: "", icon: "", category: "content",
  placement: { regions: ["main"] }, multiple: true,
  schema: { type: "object", additionalProperties: false, properties: {} },
  data: { source: "config" }, sourcePlugin: "Z endpoint", legacy: false,
  secretInternal: "never-serialize-me",
};

test("serializes the whitelist only, sorted by id, with generatedAt", () => {
  const json = JSON.parse(renderBlockCatalog([ENTRY, { ...ENTRY, id: "a-block" }]));
  assert.equal(json.catalogVersion, 1);
  assert.ok(json.generatedAt.match(/^\d{4}-\d{2}-\d{2}T/)); // ISO string (workspace convention)
  assert.deepEqual(json.blocks.map((b) => b.id), ["a-block", "z-block"]);
  assert.equal("secretInternal" in json.blocks[0], false);
  assert.equal("sourcePlugin" in json.blocks[0], false);
  assert.equal(json.blocks[0].requiresPlugin, "Z endpoint"); // stamped from sourcePlugin
});

test("built-in entry without sourcePlugin gets requiresPlugin: null", () => {
  const { sourcePlugin: _drop, ...builtin } = ENTRY;
  const json = JSON.parse(renderBlockCatalog([builtin]));
  assert.equal(json.blocks[0].requiresPlugin, null);
});

test("legacy entries keep the legacy flag in output", () => {
  const legacyEntry = { ...ENTRY, id: "old-block", legacy: true, version: 0 };
  const json = JSON.parse(renderBlockCatalog([legacyEntry]));
  assert.equal(json.blocks[0].legacy, true);
  assert.equal(json.blocks[0].version, 0);
});

test("the real BUILTIN_BLOCKS array round-trips as valid JSON with 15 blocks", () => {
  // Phase 7d removed the 7 plugin-owned widget seeds (now declared by their
  // plugins via get blocks()); 22 → 15 theme-level built-ins remain.
  const json = JSON.parse(renderBlockCatalog(BUILTIN_BLOCKS));
  assert.equal(json.blocks.length, 15);
  // Built-ins have no sourcePlugin — always available.
  assert.ok(json.blocks.every((b) => b.requiresPlugin === null));
  // Sorted by id.
  const ids = json.blocks.map((b) => b.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
});

test("output is deterministic modulo generatedAt", () => {
  const entries = [ENTRY, { ...ENTRY, id: "a-block" }];
  const first = JSON.parse(renderBlockCatalog(entries));
  const second = JSON.parse(renderBlockCatalog(entries));
  delete first.generatedAt;
  delete second.generatedAt;
  assert.deepEqual(first, second);
});

test("does not serialize fields inherited from the prototype chain", () => {
  const proto = { aliases: ["sneaky-alias"] };
  const entry = Object.assign(Object.create(proto), ENTRY);
  const json = JSON.parse(renderBlockCatalog([entry]));
  assert.equal("aliases" in json.blocks[0], false);
});

test("writes atomically and leaves no tmp files behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catalog-"));
  const path = join(dir, "block-catalog.json");
  await writeBlockCatalogJson([ENTRY], path);
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(onDisk.blocks[0].id, "z-block");
  const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("writeBlockCatalogJson creates the output directory and returns the path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catalog-"));
  const path = join(dir, "nested", "deeper", "block-catalog.json");
  const returned = await writeBlockCatalogJson([ENTRY], path);
  assert.equal(returned, path);
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(onDisk.catalogVersion, 1);
});
