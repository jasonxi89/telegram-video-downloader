const test = require("node:test");
const assert = require("node:assert/strict");
const { integration } = require("./background-harness.cjs");

function history(count) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const id = `dl_${index}_abcdef`;
    return [id, { id, tabId: 1, status: "complete", filename: `video-${index}.mp4`,
      url: `https://web.telegram.org/progressive/document${index}`, key: `doc:${index}`,
      total: 100, offset: 100, pct: 100, updatedAt: 0 }];
  }));
}

test("deleting one row persists only its ID and survives worker restart before compaction", async () => {
  const app = integration({ delayRestore: true });
  const rows = history(2000);
  app.restore({ downloads: rows, completedUrls: ["doc:0"] });
  await app.settle();
  const popup = app.popup();
  const before = app.storageWrites.length;
  popup.command("delete", "dl_0_abcdef");
  await app.settle();
  const writes = app.storageWrites.slice(before);
  assert.deepEqual(Object.keys(writes[0]), ["deletedDownloadIds"]);
  assert.deepEqual(writes, [{ deletedDownloadIds: ["dl_0_abcdef"] }]);
  assert.ok(JSON.stringify(writes[0]).length < 100);
  assert.equal(app.state().dl_0_abcdef, undefined);
  assert.ok(app.persisted().downloads.dl_0_abcdef, "old full snapshot remains until compaction");
  const restarted = integration({ delayRestore: true });
  restarted.restore(app.persisted());
  await restarted.settle();
  assert.equal(restarted.state().dl_0_abcdef, undefined);
  assert.equal(Object.keys(restarted.state()).length, 1999);
  assert.deepEqual(restarted.persisted().completedUrls, ["doc:0"]);
  assert.deepEqual(restarted.persisted().deletedDownloadIds, []);
});

test("rapid deletions coalesce and closing the current panel compacts once", async () => {
  const app = integration({ delayRestore: true });
  app.restore({ downloads: history(100) });
  await app.settle();
  const popup = app.popup();
  const before = app.storageWrites.length;
  for (let i = 0; i < 10; i++) popup.command("delete", `dl_${i}_abcdef`);
  await app.settle();
  const deletionWrites = app.storageWrites.slice(before);
  assert.equal(deletionWrites.length, 2);
  assert.ok(deletionWrites.every(write => !Object.hasOwn(write, "downloads")));
  assert.equal(app.persisted().deletedDownloadIds.length, 10);
  popup.disconnect();
  await app.settle();
  assert.equal(app.storageWrites.length, before + 4, "map persistence precedes journal cleanup");
  assert.equal(Object.keys(app.persisted().downloads).length, 90);
  assert.deepEqual(app.persisted().deletedDownloadIds, []);
});

test("an in-flight old snapshot cannot overwrite a later persisted deletion", async () => {
  const app = integration({ delayRestore: true, delayWrites: true });
  app.restore({ downloads: history(2) });
  app.popup().command("delete", "dl_0_abcdef");
  assert.equal(app.storageWrites.length, 1, "only one write is in flight");
  app.finishWrite();
  await app.settle();
  assert.deepEqual(app.storageWrites[1], { deletedDownloadIds: ["dl_0_abcdef"] });
  app.finishWrite();
  await app.settle();
  const restarted = integration({ delayRestore: true });
  restarted.restore(app.persisted());
  assert.equal(restarted.state().dl_0_abcdef, undefined);
  assert.ok(restarted.state().dl_1_abcdef);
});

test("a deletion during compaction keeps its newer journal entry", async () => {
  const app = integration({ delayRestore: true, delayWrites: true });
  app.restore({ downloads: history(3) });
  app.finishWrite();
  await app.settle();
  const first = app.popup();
  first.command("delete", "dl_0_abcdef");
  first.disconnect();
  app.finishWrite();
  await app.settle();
  assert.equal(app.storageWrites.at(-1).downloads.dl_0_abcdef, undefined);
  app.popup().command("delete", "dl_1_abcdef");
  app.finishWrite();
  await app.settle();
  assert.deepEqual(app.storageWrites.at(-1), { deletedDownloadIds: ["dl_1_abcdef"] });
  app.finishWrite();
  await app.settle();
  const restarted = integration({ delayRestore: true });
  restarted.restore(app.persisted());
  assert.deepEqual(Object.keys(restarted.state()), ["dl_2_abcdef"]);
});

test("journal write failure falls back to a compact snapshot without a retry loop", async () => {
  const app = integration({ delayRestore: true, delayWrites: true });
  app.restore({ downloads: history(2) });
  app.finishWrite();
  await app.settle();
  app.popup().command("delete", "dl_0_abcdef");
  app.finishWrite(new Error("QUOTA_BYTES quota exceeded"));
  await app.settle();
  assert.equal(app.storageWrites.at(-1).downloads.dl_0_abcdef, undefined);
  assert.equal(app.storageWrites.at(-1).deletedDownloadIds, undefined,
    "the full snapshot must not clear the journal before it succeeds");
  app.finishWrite(new Error("Storage unavailable"));
  await app.settle();
  assert.equal(app.pendingWrites(), 0, "a failed snapshot waits for the next save request");
});

test("late cancellation after removing a failed row does not rewrite all history", async () => {
  const app = integration({ delayRestore: true, deliverCommands: false });
  const rows = history(100);
  rows.dl_0_abcdef.status = "error";
  app.restore({ downloads: rows });
  await app.settle();
  app.popup().command("delete", "dl_0_abcdef");
  await app.settle();
  const writes = app.storageWrites.length;
  app.send({ source: "tg-dl", type: "dl-cancel", id: "dl_0_abcdef" });
  await app.settle();
  assert.equal(app.storageWrites.length, writes);
  assert.equal(app.sentCommands[0].action, "cancel");
});

test("a stale popup disconnect cannot compact while the current popup is open", async () => {
  const app = integration({ delayRestore: true });
  app.restore({ downloads: history(3) });
  await app.settle();
  const old = app.popup();
  const current = app.popup();
  current.command("delete", "dl_0_abcdef");
  await app.settle();
  const writes = app.storageWrites.length;
  old.disconnect();
  await app.settle();
  assert.equal(app.storageWrites.length, writes);
  current.disconnect();
  await app.settle();
  assert.equal(app.storageWrites.length, writes + 2, "write the map, then clear the journal");
  assert.equal(app.persisted().downloads.dl_0_abcdef, undefined);
});

test("large deletion batches compact rather than growing an unbounded journal", async () => {
  const app = integration({ delayRestore: true });
  app.restore({ downloads: history(200) });
  await app.settle();
  const popup = app.popup();
  const before = app.storageWrites.length;
  for (let i = 0; i < 130; i++) popup.command("delete", `dl_${i}_abcdef`);
  await app.settle();
  const snapshots = app.storageWrites.slice(before).filter(write => Object.hasOwn(write, "downloads"));
  assert.equal(snapshots.length, 1);
  assert.equal(Object.keys(app.persisted().downloads).length, 70);
  assert.deepEqual(app.persisted().deletedDownloadIds, []);
});

test("restoration validates journal IDs and ignores duplicates and malformed entries", async () => {
  const app = integration({ delayRestore: true });
  app.restore({ downloads: history(2), deletedDownloadIds: ["dl_0_abcdef", "dl_0_abcdef", null, "bad", { id: "dl_1_abcdef" }] });
  await app.settle();
  assert.deepEqual(Object.keys(app.state()), ["dl_1_abcdef"]);
  assert.deepEqual(app.persisted().deletedDownloadIds, []);
});

test("a failed old snapshot does not discard a newer queued save", async () => {
  const app = integration({ delayRestore: true, delayWrites: true });
  app.restore({ downloads: history(1) });
  app.send({ source: "tg-dl", type: "dl-start", id: "dl_1_abcdef",
    url: "https://web.telegram.org/progressive/document1", filename: "new.mp4" });
  app.finishWrite(new Error("Temporary write failure"));
  await app.settle();
  assert.equal(app.pendingWrites(), 1);
  assert.equal(app.storageWrites.at(-1).downloads.dl_1_abcdef.status, "active");
  app.finishWrite();
  await app.settle();
  assert.equal(app.persisted().downloads.dl_1_abcdef.status, "active");
});

test("a failed snapshot does not turn the next X into another full snapshot", async () => {
  const app = integration({ delayRestore: true, delayWrites: true });
  app.restore({ downloads: history(200) });
  app.finishWrite(new Error("Temporary storage failure"));
  await app.settle();
  app.popup().command("delete", "dl_0_abcdef");
  assert.deepEqual(Object.keys(app.storageWrites.at(-1)), ["deletedDownloadIds"]);
  app.finishWrite();
  await app.settle();
  assert.equal(app.pendingWrites(), 0);
  assert.deepEqual(app.persisted().deletedDownloadIds, ["dl_0_abcdef"]);
});

test("restart between snapshot commit and journal cleanup cannot revive a row", async () => {
  const app = integration({ delayRestore: true, delayWrites: true });
  app.restore({ downloads: history(2) });
  app.finishWrite();
  await app.settle();
  const popup = app.popup();
  popup.command("delete", "dl_0_abcdef");
  app.finishWrite();
  await app.settle();
  popup.disconnect();
  assert.equal(app.storageWrites.at(-1).deletedDownloadIds, undefined);
  app.finishWrite();
  await app.settle();
  assert.deepEqual(app.persisted().deletedDownloadIds, ["dl_0_abcdef"]);
  assert.equal(app.persisted().downloads.dl_0_abcdef, undefined);
  const restarted = integration({ delayRestore: true });
  restarted.restore(app.persisted());
  await restarted.settle();
  assert.deepEqual(Object.keys(restarted.state()), ["dl_1_abcdef"]);
});

test("failed cleanup leaves only harmless old markers and does not loop", async () => {
  const app = integration({ delayRestore: true, delayWrites: true });
  app.restore({ downloads: history(2), deletedDownloadIds: ["dl_0_abcdef"] });
  app.finishWrite();
  await app.settle();
  assert.deepEqual(app.storageWrites.at(-1), { deletedDownloadIds: [] });
  app.finishWrite(new Error("Cleanup failed"));
  await app.settle();
  assert.equal(app.pendingWrites(), 0);
  const restarted = integration({ delayRestore: true });
  restarted.restore(app.persisted());
  assert.deepEqual(Object.keys(restarted.state()), ["dl_1_abcdef"]);
});

for (const count of [63, 64, 65]) {
  test(`journal compaction boundary at ${count} sequential deletions`, async () => {
    const app = integration({ delayRestore: true });
    app.restore({ downloads: history(100) });
    await app.settle();
    const before = app.storageWrites.length;
    const popup = app.popup();
    for (let i = 0; i < count; i++) {
      popup.command("delete", `dl_${i}_abcdef`);
      await app.settle();
    }
    const snapshots = app.storageWrites.slice(before).filter(write => Object.hasOwn(write, "downloads"));
    assert.equal(snapshots.length, count < 64 ? 0 : 1);
    assert.equal(app.persisted().deletedDownloadIds.length, count % 64);
  });
}

test("a previous snapshot failure cannot prevent quota recovery after a deletion", async () => {
  const app = integration({ delayRestore: true, delayWrites: true });
  app.restore({ downloads: history(2) });
  app.finishWrite(new Error("Snapshot exceeds quota"));
  await app.settle();
  app.popup().command("delete", "dl_0_abcdef");
  app.finishWrite(new Error("Journal cannot fit before compaction"));
  await app.settle();
  assert.equal(app.pendingWrites(), 1, "the reduced map can fit after deleting a row");
  assert.equal(app.storageWrites.at(-1).downloads.dl_0_abcdef, undefined);
  app.finishWrite();
  await app.settle();
  app.finishWrite();
  await app.settle();
  assert.deepEqual(Object.keys(app.persisted().downloads), ["dl_1_abcdef"]);
  assert.deepEqual(app.persisted().deletedDownloadIds, []);
});
