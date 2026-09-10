const test = require("node:test");
const assert = require("node:assert/strict");
const { integration } = require("./background-harness.cjs");
const { deferred, response, waitFor } = require("./downloader-harness.cjs");
const turn = () => new Promise((resolve) => setImmediate(resolve));
const id = "dl_0_abcdef";
const url = "https://web.telegram.org/progressive/document123";
const row = (status = "error") => ({ id, tabId: 1, url, key: "doc:123", filename: "123.mp4",
  status, updatedAt: 0, offset: 0, total: 6, pct: 0, speed: 0 });

for (const action of ["delete", "clear-completed"]) {
  test(`${action} stays deleted after late progress and worker restart`, () => {
    const app = integration({ delayRestore: true, deliverCommands: false });
    app.restore({ downloads: { [id]: row() } });
    app.popup().command(action, id);
    assert.equal(app.state()[id], undefined);
    assert.equal(app.sentCommands[0].action, "cancel");
    app.send({ source: "tg-dl", type: "dl-progress", id, url, offset: 3, total: 6, pct: 50 });
    assert.equal(app.state()[id], undefined);
    const next = integration({ delayRestore: true });
    next.restore(app.storageWrites.at(-1));
    next.send({ source: "tg-dl", type: "dl-progress", id, url, offset: 6, total: 6, pct: 100 });
    assert.equal(next.state()[id], undefined);
  });
}

test("slow body remains active with warning and can still be cancelled", async () => {
  const body = deferred();
  let reading = false;
  const res = response(206, "bytes 0-2/6", "abc");
  res.blob = () => { reading = true; return body.promise; };
  const app = integration();
  const run = app.start([res]);
  await waitFor(() => reading);
  app.setTime(31000);
  const popup = app.popup();
  assert.equal(app.state()[run.id].status, "active");
  assert.match(app.state()[run.id].activityWarning, /still be running/);
  popup.command("cancel", run.id);
  body.resolve(new Blob(["abc"]));
  await run.settled();
  assert.equal(app.state()[run.id], undefined);
  assert.equal(run.saves.length, 0);
});

test("retry actual failed engine starts at zero, replaces history, ignores double click", async () => {
  const body = deferred();
  const success = response(200, null, "abcdef");
  success.blob = () => body.promise;
  const app = integration();
  const run = app.start([() => Promise.reject(new Error("offline")), success]);
  await run.settled();
  assert.equal(app.state()[run.id].status, "error");
  const popup = app.popup();
  popup.command("retry", run.id);
  popup.command("retry", run.id);
  await waitFor(() => run.requests.length === 2);
  const [newId] = Object.keys(app.state());
  assert.notEqual(newId, run.id);
  assert.equal(app.state()[newId].status, "active");
  assert.equal(run.requests[1].headers.Range, "bytes=0-");
  assert.equal(app.sentCommands.filter((m) => m.action === "retry").length, 1);
  body.resolve(new Blob(["abcdef"]));
  await waitFor(() => app.state()[newId]?.status === "complete");
  assert.equal(run.saves.length, 1);
  assert.equal(await run.saves[0].text(), "abcdef");
});

test("retry aborts a falsely failed old fetch before new fetch; late old body cannot save", async () => {
  const body = deferred();
  let reading = false;
  const res = response(200, null, "old");
  res.blob = () => { reading = true; return body.promise; };
  const app = integration();
  const run = app.start([res, response(200, null, "new")]);
  await waitFor(() => reading);
  app.send({ source: "tg-dl", type: "dl-error", id: run.id, error: "legacy timeout" });
  app.popup().command("retry", run.id);
  assert(run.requests[0].signal.aborted);
  await waitFor(() => run.saves.length === 1);
  body.resolve(new Blob(["old"]));
  await turn();
  assert.equal(run.saves.length, 1);
  assert.equal(await run.saves[0].text(), "new");
  assert.equal(Object.keys(app.state()).length, 1);
});

test("missing bridge reports retry timeout without losing failure history", () => {
  const app = integration({ delayRestore: true, deliverCommands: false });
  app.restore({ downloads: { [id]: row() } });
  const popup = app.popup();
  popup.command("retry", id);
  popup.command("retry", id);
  assert.equal(app.sentCommands.length, 1);
  assert.equal(app.state()[id].retrying, true);
  popup.command("delete", id);
  assert(app.state()[id]);
  app.tick(5001);
  assert.equal(app.state()[id].retrying, undefined);
  assert.equal(app.state()[id].status, "error");
  assert.match(app.state()[id].commandError, /not confirmed/);
  popup.command("delete", id);
  assert.equal(app.state()[id], undefined);
});

test("retry without source shows actionable feedback, no request", () => {
  const app = integration({ delayRestore: true });
  app.restore({ downloads: { [id]: { ...row(), url: "" } } });
  app.popup().command("retry", id);
  assert.equal(app.sentCommands.length, 0);
  assert.match(app.state()[id].commandError, /source unavailable/);
});

test("delete queued before storage ready is applied after restore", async () => {
  const app = integration({ delayRestore: true, deliverCommands: false });
  app.popup().command("delete", id);
  app.restore({ downloads: { [id]: row() } });
  await turn();
  assert.equal(app.state()[id], undefined);
  assert.equal(app.storageWrites.at(-1).downloads[id], undefined);
});

test("foreign retry acknowledgement cannot remove another tab's failed entry", () => {
  const app = integration({ delayRestore: true, deliverCommands: false });
  app.restore({ downloads: { [id]: row() } });
  app.popup().command("retry", id);
  app.send({ source: "tg-dl", type: "dl-start", id: "dl_1_abcdef", retryOf: id, url },
    { tab: { id: 2, url: "https://web.telegram.org/k/" }, frameId: 0 });
  assert(app.state()[id]);
  assert.equal(app.state().dl_1_abcdef, undefined);
});

test("a retry that fails again remains retryable as a new task", async () => {
  const app = integration();
  const run = app.start([
    () => Promise.reject(new Error("first failure")),
    () => Promise.reject(new Error("second failure")),
    response(200, null, "ok"),
  ]);
  await run.settled();
  const popup = app.popup();
  popup.command("retry", run.id);
  await waitFor(() => Object.values(app.state()).some((dl) => dl.error === "second failure"));
  const [failedId] = Object.keys(app.state());
  popup.command("retry", failedId);
  await waitFor(() => Object.values(app.state()).some((dl) => dl.status === "complete"));
  assert.equal(Object.keys(app.state()).length, 1);
  assert.equal(run.saves.length, 1);
});

test("late retry start after history removal is cancelled rather than recreated", () => {
  const app = integration({ delayRestore: true, deliverCommands: false });
  app.restore({ downloads: { [id]: row() } });
  const popup = app.popup();
  popup.command("retry", id);
  app.tick(5001);
  popup.command("delete", id);
  app.send({ source: "tg-dl", type: "dl-start", id: "dl_1_abcdef", url, retryOf: id });
  assert.equal(Object.keys(app.state()).length, 0);
  assert.equal(app.sentCommands.at(-1).action, "cancel");
  assert.equal(app.sentCommands.at(-1).id, "dl_1_abcdef");
});

test("active download cannot be retried from a stale popup", () => {
  const app = integration({ delayRestore: true, deliverCommands: false });
  app.restore({ downloads: { [id]: row("active") } });
  app.popup().command("retry", id);
  assert.equal(app.sentCommands.length, 0);
  assert.equal(app.state()[id].status, "active");
});
