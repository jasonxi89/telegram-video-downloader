const test = require("node:test");
const assert = require("node:assert/strict");
const { integration } = require("./background-harness.cjs");

function history(count) {
  const rows = {};
  for (let i = 0; i < count; i++) {
    const id = `dl_${i}_abcdef`;
    rows[id] = { id, tabId: 1, url: "https://web.telegram.org/progressive/document" + i,
      key: "doc:" + i, filename: i + ".mp4", status: i % 2 ? "error" : "complete",
      updatedAt: 0, offset: 6, total: 6, pct: 100, speed: 0 };
  }
  return rows;
}

test("clear-completed persists and notifies once regardless of history size", async () => {
  const app = integration({ delayRestore: true, deliverCommands: false });
  app.restore({ downloads: history(40), completedUrls: ["doc:1"] });
  await app.settle();
  const popup = app.popup();
  const writes = app.storageWrites.length;
  const messages = app.popupMessages.length;
  popup.command("clear-completed");
  await app.settle();
  assert.equal(Object.keys(app.state()).length, 0);
  assert.equal(app.storageWrites.length - writes, 1, "one storage write for the whole clear");
  assert.deepEqual(app.storageWrites.at(-1), { downloads: {}, completedUrls: [] });
  assert.deepEqual(app.popupMessages.slice(messages).map((m) => m.type), ["state-snapshot"]);
  // Best-effort stop is still requested once per failed row.
  assert.equal(app.sentCommands.filter((m) => m.action === "cancel").length, 20);
});
