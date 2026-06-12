import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addBlock,
  removeBlock,
  restoreBlock,
  moveBlock,
  moveBlockToZone,
  updateBlockConfig,
} from "../lib/editor/block-ops.js";

const makeIds = () => { let n = 0; return (prefix) => `${prefix}_${String(++n).padStart(6, "0")}`; };

const section = (id, type, config = {}) => ({ block: "section", id, type, v: 0, config });

const makeZones = () => ({
  arrangement: "sidebar-right",
  hero: section("b_hero", "hero", { showSocial: true }),
  main: [section("b_m1", "recent-posts", { maxItems: 10 }), section("b_m2", "posting-activity")],
  sidebar: [section("b_s1", "author-card")],
  footer: [section("b_f1", "custom-html")],
  _containerIds: { root: "c_r", columns: "c_c", main: "c_m", sidebar: "c_s", footer: "c_f" },
});

/** Run an op and assert the input zones object was not mutated. */
const unmutated = (op) => {
  const zones = makeZones();
  const snapshot = structuredClone(zones);
  const result = op(zones);
  assert.deepEqual(zones, snapshot, "input zones mutated");
  return result;
};

// ---- addBlock ----

test("addBlock appends a fresh section node to a list zone", () => {
  const result = unmutated((zones) =>
    addBlock(zones, { zone: "main", type: "search", config: { placeholder: "go" }, idFactory: makeIds() }),
  );
  assert.equal(result.error, undefined);
  assert.equal(result.zones.main.length, 3);
  assert.deepEqual(result.zones.main[2], {
    block: "section", id: "b_000001", type: "search", v: 0, config: { placeholder: "go" },
  });
  // other zones untouched
  assert.equal(result.zones.sidebar.length, 1);
});

test("addBlock defaults config to {} when omitted", () => {
  const result = unmutated((zones) =>
    addBlock(zones, { zone: "footer", type: "custom-html", idFactory: makeIds() }),
  );
  assert.deepEqual(result.zones.footer[1].config, {});
});

test("addBlock into an occupied hero slot → hero-occupied error, zones unchanged", () => {
  const result = unmutated((zones) =>
    addBlock(zones, { zone: "hero", type: "hero", config: {}, idFactory: makeIds() }),
  );
  assert.equal(result.error, "hero-occupied");
  assert.deepEqual(result.zones, makeZones());
});

test("addBlock into an empty hero slot sets it", () => {
  const zones = { ...makeZones(), hero: null };
  const result = addBlock(zones, { zone: "hero", type: "hero", config: { showSocial: false }, idFactory: makeIds() });
  assert.equal(result.error, undefined);
  assert.equal(result.zones.hero.type, "hero");
  assert.equal(result.zones.hero.id, "b_000001");
  assert.equal(zones.hero, null); // input untouched
});

// ---- removeBlock ----

test("removeBlock removes from a list zone and reports node/zone/index", () => {
  const result = unmutated((zones) => removeBlock(zones, { blockId: "b_m2" }));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.zones.main.map((n) => n.id), ["b_m1"]);
  assert.equal(result.removed.zone, "main");
  assert.equal(result.removed.index, 1);
  assert.equal(result.removed.node.id, "b_m2");
});

test("removeBlock clears the hero slot", () => {
  const result = unmutated((zones) => removeBlock(zones, { blockId: "b_hero" }));
  assert.equal(result.zones.hero, null);
  assert.equal(result.removed.zone, "hero");
  assert.equal(result.removed.node.type, "hero");
});

test("removeBlock unknown id → not-found error, zones equal but fresh", () => {
  const zones = makeZones();
  const result = removeBlock(zones, { blockId: "b_nope" });
  assert.equal(result.error, "not-found");
  assert.deepEqual(result.zones, zones);
  assert.notEqual(result.zones, zones);
});

// ---- restoreBlock (undo support) ----

test("removeBlock + restoreBlock round-trips a list zone exactly", () => {
  const zones = makeZones();
  const { zones: after, removed } = removeBlock(zones, { blockId: "b_m1" });
  const { zones: restored } = restoreBlock(after, removed);
  assert.deepEqual(restored, zones);
});

test("restoreBlock clamps an out-of-range index", () => {
  const result = unmutated((zones) =>
    restoreBlock(zones, { node: section("b_new", "search"), zone: "sidebar", index: 99 }),
  );
  assert.deepEqual(result.zones.sidebar.map((n) => n.id), ["b_s1", "b_new"]);
  const negative = restoreBlock(makeZones(), { node: section("b_neg", "search"), zone: "main", index: -5 });
  assert.equal(negative.zones.main[0].id, "b_neg");
});

test("restoreBlock into an occupied hero slot → hero-occupied error", () => {
  const result = unmutated((zones) =>
    restoreBlock(zones, { node: section("b_h2", "hero"), zone: "hero", index: 0 }),
  );
  assert.equal(result.error, "hero-occupied");
  assert.equal(result.zones.hero.id, "b_hero");
});

test("removeBlock + restoreBlock round-trips the hero slot", () => {
  const zones = makeZones();
  const { zones: after, removed } = removeBlock(zones, { blockId: "b_hero" });
  const { zones: restored, error } = restoreBlock(after, removed);
  assert.equal(error, undefined);
  assert.deepEqual(restored, zones);
});

// ---- moveBlock ----

test("moveBlock moves a block up/down within its zone", () => {
  const down = unmutated((zones) => moveBlock(zones, { blockId: "b_m1", direction: "down" }));
  assert.deepEqual(down.zones.main.map((n) => n.id), ["b_m2", "b_m1"]);
  const up = moveBlock(down.zones, { blockId: "b_m1", direction: "up" });
  assert.deepEqual(up.zones.main.map((n) => n.id), ["b_m1", "b_m2"]);
});

test("moveBlock at the edge is a no-op returning equal-but-fresh zones", () => {
  const zones = makeZones();
  for (const [blockId, direction] of [["b_m1", "up"], ["b_m2", "down"], ["b_s1", "up"], ["b_hero", "up"]]) {
    const result = moveBlock(zones, { blockId, direction });
    assert.equal(result.error, undefined, blockId);
    assert.deepEqual(result.zones, zones, blockId);
    assert.notEqual(result.zones, zones, blockId);
  }
});

test("moveBlock unknown id → not-found", () => {
  const result = unmutated((zones) => moveBlock(zones, { blockId: "b_nope", direction: "up" }));
  assert.equal(result.error, "not-found");
});

// ---- moveBlockToZone ----

test("moveBlockToZone appends to the target zone and removes from the source", () => {
  const result = unmutated((zones) => moveBlockToZone(zones, { blockId: "b_m1", zone: "sidebar" }));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.zones.main.map((n) => n.id), ["b_m2"]);
  assert.deepEqual(result.zones.sidebar.map((n) => n.id), ["b_s1", "b_m1"]);
  // node identity preserved (id and config untouched)
  assert.deepEqual(result.zones.sidebar[1], makeZones().main[0]);
});

test("moveBlockToZone hero → list is allowed mechanically", () => {
  const result = unmutated((zones) => moveBlockToZone(zones, { blockId: "b_hero", zone: "main" }));
  assert.equal(result.zones.hero, null);
  assert.deepEqual(result.zones.main.map((n) => n.id), ["b_m1", "b_m2", "b_hero"]);
});

test("moveBlockToZone list → empty hero slot is allowed mechanically", () => {
  const zones = { ...makeZones(), hero: null };
  const result = moveBlockToZone(zones, { blockId: "b_m2", zone: "hero" });
  assert.equal(result.error, undefined);
  assert.equal(result.zones.hero.id, "b_m2");
  assert.deepEqual(result.zones.main.map((n) => n.id), ["b_m1"]);
});

test("moveBlockToZone into an occupied hero slot → hero-occupied, block NOT lost", () => {
  const result = unmutated((zones) => moveBlockToZone(zones, { blockId: "b_m1", zone: "hero" }));
  assert.equal(result.error, "hero-occupied");
  assert.deepEqual(result.zones, makeZones()); // unchanged — the block stayed put
});

test("moveBlockToZone unknown id → not-found", () => {
  const result = unmutated((zones) => moveBlockToZone(zones, { blockId: "b_nope", zone: "main" }));
  assert.equal(result.error, "not-found");
});

// ---- updateBlockConfig ----

test("updateBlockConfig replaces config, leaving id/type/v untouched", () => {
  const result = unmutated((zones) =>
    updateBlockConfig(zones, { blockId: "b_m1", config: { maxItems: 5, postTypes: ["note"] } }),
  );
  const node = result.zones.main[0];
  assert.deepEqual(node, {
    block: "section", id: "b_m1", type: "recent-posts", v: 0,
    config: { maxItems: 5, postTypes: ["note"] },
  });
});

test("updateBlockConfig works on the hero slot", () => {
  const result = unmutated((zones) =>
    updateBlockConfig(zones, { blockId: "b_hero", config: { showSocial: false } }),
  );
  assert.deepEqual(result.zones.hero.config, { showSocial: false });
  assert.equal(result.zones.hero.id, "b_hero");
});

test("updateBlockConfig unknown id → not-found", () => {
  const result = unmutated((zones) =>
    updateBlockConfig(zones, { blockId: "b_nope", config: {} }),
  );
  assert.equal(result.error, "not-found");
});

// ---- shared immutability depth ----

test("ops return fresh zone arrays (no aliasing back into the input)", () => {
  const zones = makeZones();
  const { zones: next } = addBlock(zones, { zone: "main", type: "search", idFactory: makeIds() });
  assert.notEqual(next, zones);
  assert.notEqual(next.main, zones.main);
  assert.notEqual(next.sidebar, zones.sidebar);
  assert.notEqual(next.footer, zones.footer);
  // mutating the result must not leak into the input
  next.main.push(section("b_leak", "search"));
  assert.equal(zones.main.length, 2);
});
