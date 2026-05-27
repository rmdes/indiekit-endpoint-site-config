import { test } from "node:test";
import assert from "node:assert/strict";
import { maybeBackfillIdentity } from "../lib/storage/backfill-identity.js";

// In-memory MongoDB stub with two collections
function makeIndiekitStub(siteDoc, homepageDoc) {
  let sd = siteDoc;
  const hd = homepageDoc;
  return {
    database: {
      collection(name) {
        if (name === "siteConfig") {
          return {
            async findOne() { return sd; },
            async replaceOne(_filter, doc) { sd = doc; return { acknowledged: true }; },
          };
        }
        if (name === "homepageConfig") {
          return {
            async findOne() { return hd; },
          };
        }
      },
    },
    // expose for assertions
    _getSiteDoc: () => sd,
  };
}

test("backfill runs when siteConfig.identity is stub and homepageConfig has rich identity", async () => {
  const stub = makeIndiekitStub(
    { _id: "primary", identity: { name: "", avatar: "", bio: "" } },
    { _id: "homepage", identity: { name: "Rick", avatar: "https://x.com/me.jpg", bio: "Brussels" } }
  );
  const result = await maybeBackfillIdentity(stub);
  assert.equal(result, true);
  const sd = stub._getSiteDoc();
  assert.equal(sd.identity.name, "Rick");
  assert.equal(sd.identity.avatar, "https://x.com/me.jpg");
  assert.equal(sd.identity.bio, "Brussels");
});

test("backfill does not run when siteConfig.identity already has name", async () => {
  const stub = makeIndiekitStub(
    { _id: "primary", identity: { name: "Existing", avatar: "", bio: "" } },
    { _id: "homepage", identity: { name: "Other", avatar: "https://x.com/me.jpg", bio: "Bio" } }
  );
  const result = await maybeBackfillIdentity(stub);
  assert.equal(result, false);
  assert.equal(stub._getSiteDoc().identity.name, "Existing");
});

test("backfill does not run when homepageConfig is empty", async () => {
  const stub = makeIndiekitStub(
    { _id: "primary", identity: { name: "", avatar: "", bio: "" } },
    null
  );
  const result = await maybeBackfillIdentity(stub);
  assert.equal(result, false);
});

test("backfill does not run when homepageConfig.identity is also stub", async () => {
  const stub = makeIndiekitStub(
    { _id: "primary", identity: { name: "", avatar: "", bio: "" } },
    { _id: "homepage", identity: { name: "", avatar: "", bio: "" } }
  );
  const result = await maybeBackfillIdentity(stub);
  assert.equal(result, false);
});

test("backfill no-ops when no DB", async () => {
  const result = await maybeBackfillIdentity({ database: null });
  assert.equal(result, false);
});

test("backfill no-ops when siteConfig document missing (greenfield install)", async () => {
  const stub = makeIndiekitStub(null,
    { _id: "homepage", identity: { name: "Rick", avatar: "https://x.com/me.jpg", bio: "Bio" } });
  const result = await maybeBackfillIdentity(stub);
  assert.equal(result, false);
});

test("backfill is idempotent — running twice still no-ops the second time", async () => {
  const stub = makeIndiekitStub(
    { _id: "primary", identity: { name: "", avatar: "", bio: "" } },
    { _id: "homepage", identity: { name: "Rick", avatar: "https://x.com/me.jpg", bio: "Brussels" } }
  );
  const first = await maybeBackfillIdentity(stub);
  assert.equal(first, true);
  const second = await maybeBackfillIdentity(stub);
  assert.equal(second, false);
});
