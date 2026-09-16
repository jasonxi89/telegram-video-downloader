const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { harness, deferred, response, waitFor, assertTerminal } = require("./downloader-harness.cjs");

const { integration } = require("./background-harness.cjs");

test("headers at 20s preserve cancellation at 31s without inventing byte progress", async () => {
  const app = integration();
  const headers = deferred();
  const body = deferred();
  let reading = false;
  const res = response(206, "bytes 0-2/6", "abc");
  res.blob = () => { reading = true; return body.promise; };
  const run = app.start([() => headers.promise]);
  app.setTime(20000);
  headers.resolve(res);
  await waitFor(() => reading);
  assert.equal(app.state()[run.id].updatedAt, 20000);
  assert.equal(run.statuses("dl-progress").length, 0);
  assert.equal(app.state()[run.id].offset, 0);
  assert.equal(app.state()[run.id].pct, 0);
  app.setTime(31000);
  const popup = app.popup();
  assert.equal(app.state()[run.id].status, "active");
  popup.command("cancel", run.id);
  assert.equal(app.sentCommands.at(-1).action, "cancel");
  body.resolve(new Blob(["abc"]));
  await run.settled();
  assertTerminal(run, "dl-cancel");
  assert.equal(app.state()[run.id], undefined);
});

test("activity cannot spoof ownership, acknowledge commands or revive terminal state", async () => {
  const app = integration({ deliverCommands: false });
  const headers = deferred();
  const run = app.start([() => headers.promise]);
  await new Promise((resolve) => setImmediate(resolve));
  const message = { source: "tg-dl", type: "dl-activity", id: run.id };
  const popup = app.popup();
  popup.command("pause", run.id);
  assert.equal(app.state()[run.id].status, "active");
  app.setTime(1000);
  app.send(message, { tab: { id: 2, url: "https://web.telegram.org/k/" }, frameId: 0 });
  assert.equal(app.state()[run.id].updatedAt, 0);
  app.send({ ...message, id: "dl_99_abcdef" });
  assert.equal(Object.keys(app.state()).length, 1);
  app.send(message);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.state()[run.id].updatedAt, 1000);
  app.tick(2001);
  assert.match(app.state()[run.id].commandError, /Pause was not confirmed/);
  app.setTime(3000);
  app.send(message);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(app.state()[run.id].commandError, /Pause was not confirmed/);
  popup.command("cancel", run.id);
  assert.equal(app.state()[run.id].status, "cancelling");
  app.setTime(3500);
  app.send(message);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.state()[run.id].updatedAt, 3000);
  app.tick(5001);
  assert.equal(app.state()[run.id].status, "error");
  app.setTime(6000);
  app.send(message);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.state()[run.id].status, "error");
  assert.equal(app.state()[run.id].updatedAt, 5001);
  run.command("cancel");
  headers.resolve(response(200, null, "abc"));
  await run.settled();
});

function persistedDownload(id, overrides = {}) {
  return { id, tabId: 1, url: "https://web.telegram.org/progressive/document123",
    key: "doc:123", filename: "123.mp4", status: "active", updatedAt: 0,
    offset: 0, total: 0, pct: 0, speed: 0, ...overrides };
}

for (const headersAt of [35000, 65000]) {
test(`header activity at ${headersAt}ms precedes restored stale classification`, async () => {
  const app = integration({ delayRestore: true, deliverCommands: false });
  const id = "dl_0_abcdef";
  app.setTime(headersAt);
  app.pageSend({ source: "tg-dl", type: "dl-activity", id });
  assert.equal(app.state()[id], undefined);
  // Keep restoration pending across a full turn; Promise.resolve is not a barrier.
  await new Promise((resolve) => setImmediate(resolve));
  app.restore({ downloads: { [id]: persistedDownload(id) } });
  await waitFor(() => app.state()[id]?.updatedAt === headersAt);
  app.setTime(headersAt + 1000);
  const popup = app.popup();
  assert.equal(app.state()[id].status, "active");
  assert.equal(app.state()[id].offset, 0);
  popup.command("cancel", id);
  assert.equal(app.sentCommands.at(-1).action, "cancel");
});

}

test("queued activity rechecks restored ownership and status, not only pre-restore state", async () => {
  for (const overrides of [{ tabId: 2 }, { status: "error" }, { status: "complete" },
    { status: "cancelling" }]) {
    const app = integration({ delayRestore: true });
    const id = "dl_0_abcdef";
    app.setTime(1000);
    app.pageSend({ source: "tg-dl", type: "dl-activity", id });
    app.restore({ downloads: { [id]: persistedDownload(id, overrides) } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.state()[id].updatedAt, 0);
    assert.equal(app.state()[id].status, overrides.status || "active");
  }
});

test("queued activity cannot overwrite a newer timestamp or acknowledge a later terminal event", async () => {
  const app = integration({ delayRestore: true });
  const id = "dl_0_abcdef";
  app.setTime(1000);
  app.pageSend({ source: "tg-dl", type: "dl-activity", id });
  app.restore({ downloads: { [id]: persistedDownload(id, { updatedAt: 2000 }) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.state()[id].updatedAt, 2000);
  app.setTime(3000);
  app.pageSend({ source: "tg-dl", type: "dl-activity", id });
  app.send({ source: "tg-dl", type: "dl-error", id, error: "stopped" });
  app.setTime(4000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.state()[id].status, "error");
  assert.equal(app.state()[id].updatedAt, 3000);
});

test("content bridge rejects activity from another origin or window", async () => {
  const app = integration({ delayRestore: true });
  const id = "dl_0_abcdef";
  app.restore({ downloads: { [id]: persistedDownload(id) } });
  app.setTime(1000);
  const message = { source: "tg-dl", type: "dl-activity", id };
  app.pageSend(message, "https://example.invalid");
  app.pageSend(message, "https://web.telegram.org", {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.state()[id].updatedAt, 0);
});

test("restore applies only the owner's observation and never creates unknown IDs", async () => {
  const app = integration({ delayRestore: true });
  const id = "dl_0_abcdef";
  const message = { source: "tg-dl", type: "dl-activity", id };
  app.setTime(65000);
  app.pageSend(message);
  app.setTime(66000);
  app.send(message, { tab: { id: 2, url: "https://web.telegram.org/k/" }, frameId: 0 });
  app.pageSend({ ...message, id: "dl_1_abcdef" });
  await new Promise((resolve) => setImmediate(resolve));
  app.restore({ downloads: { [id]: persistedDownload(id) } });
  assert.equal(app.state()[id].updatedAt, 65000);
  assert.equal(app.state()[id].status, "active");
  assert.equal(Object.keys(app.state()).length, 1);
});

test("old paused rows accept activity but old terminal and cancelling rows do not", async () => {
  for (const status of ["paused", "complete", "error", "cancelling"]) {
    const app = integration({ delayRestore: true });
    const id = "dl_0_abcdef";
    app.setTime(65000);
    app.pageSend({ source: "tg-dl", type: "dl-activity", id });
    await new Promise((resolve) => setImmediate(resolve));
    app.restore({ downloads: { [id]: persistedDownload(id, { status }) } });
    assert.equal(app.state()[id].updatedAt, status === "paused" ? 65000 : 0);
    assert.equal(app.state()[id].status, status === "cancelling" ? "error" : status);
  }
});

test("newer in-memory terminal state wins over queued activity and stale storage", async () => {
  const app = integration({ delayRestore: true });
  const id = "dl_0_abcdef";
  app.setTime(65000);
  app.pageSend({ source: "tg-dl", type: "dl-activity", id });
  app.setTime(66000);
  app.send({ source: "tg-dl", type: "dl-start", id,
    url: "https://web.telegram.org/progressive/document123", filename: "new.mp4" });
  app.send({ source: "tg-dl", type: "dl-error", id, error: "body failed" });
  app.restore({ downloads: { [id]: persistedDownload(id) } });
  assert.equal(app.state()[id].status, "error");
  assert.equal(app.state()[id].error, "body failed");
  assert.equal(app.state()[id].updatedAt, 66000);
});

test("queued activity uses observation time, not restoration time, for staleness", async () => {
  const app = integration({ delayRestore: true });
  const id = "dl_0_abcdef";
  app.setTime(1000);
  app.pageSend({ source: "tg-dl", type: "dl-activity", id });
  app.setTime(65000);
  app.restore({ downloads: { [id]: persistedDownload(id) } });
  assert.equal(app.state()[id].updatedAt, 1000);
  assert.equal(app.state()[id].status, "error");
});

test("body failure after headers survives worker restoration without a new start", async () => {
  const app = integration({ delayRestore: true });
  const headers = deferred();
  const body = deferred();
  let reading = false;
  const res = response(206, "bytes 0-2/6", "abc");
  res.blob = () => { reading = true; return body.promise; };
  const run = app.start([() => headers.promise], { workerRestarted: true });
  app.setTime(65000);
  headers.resolve(res);
  await waitFor(() => reading);
  app.setTime(66000);
  body.reject(new Error("body disconnected"));
  await run.settled();
  assertTerminal(run, "dl-error");
  assert.equal(app.state()[run.id], undefined);
  app.setTime(80000);
  app.restore({ downloads: { [run.id]: persistedDownload(run.id) } });
  assert.equal(app.state()[run.id].status, "error");
  assert.equal(app.state()[run.id].error, "body disconnected");
  assert.equal(app.state()[run.id].updatedAt, 66000);
});

for (const outcome of ["cancel", "complete", "pause-resume"]) {
  test(`restoration replays activity then ${outcome} through the live state handler`, async () => {
    const app = integration({ delayRestore: true });
    const id = "dl_0_abcdef";
    const message = { source: "tg-dl", id, url: "https://web.telegram.org/progressive/document123" };
    app.setTime(65000);
    app.pageSend({ ...message, type: "dl-activity" });
    app.setTime(66000);
    if (outcome === "pause-resume") {
      app.pageSend({ ...message, type: "dl-pause" });
      app.setTime(67000);
      app.pageSend({ ...message, type: "dl-resume" });
    } else if (outcome === "complete") {
      app.pageSend({ ...message, type: "dl-progress", offset: 3, total: 3, pct: 100 });
      app.pageSend({ ...message, type: "dl-complete", filename: "123.mp4", total: 3 });
    } else {
      app.pageSend({ ...message, type: "dl-cancel" });
      app.pageSend({ ...message, type: "dl-activity" });
    }
    await new Promise((resolve) => setImmediate(resolve));
    app.setTime(80000);
    app.restore({ downloads: { [id]: persistedDownload(id) } });
    if (outcome === "cancel") assert.equal(app.state()[id], undefined);
    else {
      assert.equal(app.state()[id].status, outcome === "complete" ? "complete" : "active");
      assert.equal(app.state()[id].updatedAt, outcome === "complete" ? 66000 : 67000);
    }
  });
}

test("queued foreign status cannot mutate the restored owner's download", async () => {
  const app = integration({ delayRestore: true });
  const id = "dl_0_abcdef";
  app.setTime(65000);
  app.pageSend({ source: "tg-dl", id, type: "dl-activity" });
  app.send({ source: "tg-dl", id, type: "dl-error", error: "foreign" },
    { tab: { id: 2, url: "https://web.telegram.org/k/" }, frameId: 0 });
  app.restore({ downloads: { [id]: persistedDownload(id) } });
  assert.equal(app.state()[id].status, "active");
  assert.equal(app.state()[id].error, undefined);
});

for (const stored of [undefined, { downloads: { dl_9_abcdef: null, bad: 42 } }]) {
  test(`invalid storage (${stored ? "null row" : "missing snapshot"}) does not discard live events`, () => {
    const app = integration({ delayRestore: true });
    app.popup();
    for (let i = 1; i <= 3; i++) {
      app.send({ source: "tg-dl", type: "dl-start", id: `dl_${i}_abcdef`,
        url: "https://web.telegram.org/progressive/document123", filename: `${i}.mp4` });
    }
    app.restore(stored);
    assert.equal(Object.keys(app.state()).length, 3);
    for (let i = 1; i <= 3; i++) assert.equal(app.state()[`dl_${i}_abcdef`].filename, `${i}.mp4`);
    assert.equal(app.storageWrites.length, 1);
    assert.equal(Object.keys(app.storageWrites[0].downloads).length, 3);
    assert.equal(Object.keys(app.popupMessages.at(-1).downloads).length, 3);
  });
}

test("one replay side-effect failure does not discard later events or final snapshot", () => {
  const app = integration({ delayRestore: true, badgeThrows: true });
  for (let i = 1; i <= 3; i++) app.send({ source: "tg-dl", type: "dl-start",
    id: `dl_${i}_abcdef`, url: "https://web.telegram.org/progressive/document123", filename: `${i}.mp4` });
  app.restore({});
  assert.equal(Object.keys(app.state()).length, 3);
  assert.equal(app.storageWrites.length, 1);
  assert.equal(Object.keys(app.storageWrites[0].downloads).length, 3);
});

test("replay publishes only one authoritative write and snapshot, no intermediate updates", () => {
  const app = integration({ delayRestore: true });
  app.popup();
  const id = "dl_0_abcdef";
  const message = { source: "tg-dl", id, url: "https://web.telegram.org/progressive/document123" };
  app.send({ ...message, type: "dl-start", filename: "123.mp4" });
  app.send({ ...message, type: "dl-activity" });
  app.send({ ...message, type: "dl-progress", offset: 3, total: 6, pct: 50 });
  app.send({ ...message, type: "dl-error", error: "disconnected" });
  assert.equal(app.storageWrites.length, 0);
  app.restore({});
  assert.equal(app.storageWrites.length, 1);
  assert.equal(app.storageWrites[0].downloads[id].status, "error");
  assert.deepEqual(app.popupMessages.map((m) => m.type), ["state-snapshot", "state-snapshot"]);
  assert.equal(app.popupMessages.at(-1).downloads[id].error, "disconnected");
  app.tick(2001);
  assert.equal(app.storageWrites.length, 1, "no intermediate progress save timer survives replay");
});
