import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readBuildStatus,
  BUILD_STATUS_PATH,
} from "../lib/storage/read-build-status.js";

const dir = () => mkdtemp(join(tmpdir(), "build-status-"));

test("reads a valid build-status file", async () => {
  const path = join(await dir(), "build-status.json");
  const status = {
    state: "ok",
    buildId: "b1",
    startedAt: "2026-06-12T10:00:00.000Z",
    finishedAt: "2026-06-12T10:00:27.000Z",
    durationSeconds: 27,
    lastOkDurationSeconds: 27,
  };
  await writeFile(path, JSON.stringify(status), "utf8");
  assert.deepEqual(await readBuildStatus(path), status);
});

test("absent file → null (never throws)", async () => {
  assert.equal(await readBuildStatus(join(await dir(), "nope.json")), null);
});

test("corrupt JSON → null (never throws)", async () => {
  const path = join(await dir(), "build-status.json");
  await writeFile(path, "{ not json", "utf8");
  assert.equal(await readBuildStatus(path), null);
});

test("non-object content (scalar, array, null) → null", async () => {
  const base = await dir();
  for (const [name, content] of [
    ["scalar.json", "42"],
    ["array.json", "[1,2]"],
    ["null.json", "null"],
  ]) {
    const path = join(base, name);
    await writeFile(path, content, "utf8");
    assert.equal(await readBuildStatus(path), null, name);
  }
});

test("default path is /app/data/build-status.json (outside the site output)", async () => {
  assert.equal(BUILD_STATUS_PATH, "/app/data/build-status.json");
  // Guard against the default ever drifting from the exported constant.
  const source = await readFile(
    new URL("../lib/storage/read-build-status.js", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes("path = BUILD_STATUS_PATH"));
});
