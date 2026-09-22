const test = require("node:test");
const assert = require("node:assert/strict");
const { integration } = require("./background-harness.cjs");

test("completion for a download without a history row still records its key", async () => {
  const app = integration({ delayRestore: true });
  app.restore({});
  const id = "dl_7_abcdef";
  const url = "https://web.telegram.org/progressive/document7";
  app.send({ source: "tg-dl", type: "dl-complete", id, url, filename: "7.mp4", total: 6 });
  assert.equal(app.state()[id], undefined, "late completion must not recreate a deleted row");
  await app.settle();
  assert.deepEqual(app.persisted().completedUrls, ["doc:7"]);
  assert.ok(app.popupMessages.every((m) => m.type !== "dl-update"));
});

test("duplicate completion without a row does not persist unchanged history again", async () => {
  const app = integration({ delayRestore: true });
  app.restore({ completedUrls: ["doc:7"] });
  await app.settle();
  const writes = app.storageWrites.length;
  app.send({ source: "tg-dl", type: "dl-complete", id: "dl_7_abcdef",
    url: "https://web.telegram.org/progressive/document7", key: "doc:7", filename: "7.mp4", total: 6 });
  await app.settle();
  assert.equal(app.storageWrites.length, writes);
});
