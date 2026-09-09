const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { harness, deferred, response, waitFor, assertTerminal } = require("./downloader-harness.cjs");

function event() {
  const listeners = [];
  return {
    addListener(fn) { listeners.push(fn); },
    emit(...args) { for (const fn of listeners) fn(...args); },
  };
}

// Real downloader -> real content bridge -> real background, all in local VMs.
function integration({ deliverCommands = true, delayRestore = false } = {}) {
  let now = 0;
  let restore;
  let timerId = 0;
  const timers = new Map();
  class Clock extends Date { static now() { return now; } }
  const sender = { tab: { id: 1, url: "https://web.telegram.org/k/" }, frameId: 0 };
  const backgroundMessage = event();
  const connects = event();
  const contentMessage = event();
  const pageMessage = event();
  const sentCommands = [];
  const background = vm.createContext({
    URL, Date: Clock, console,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    chrome: {
      tabs: {
        onUpdated: event(),
        async sendMessage(tabId, message) {
          sentCommands.push(message);
          if (deliverCommands) contentMessage.emit(message);
        },
      },
      runtime: { onMessage: backgroundMessage, onConnect: connects, onInstalled: event(), onStartup: event() },
      storage: { local: {
        get(_keys, callback) {
          restore = callback;
          if (!delayRestore) queueMicrotask(() => callback({}));
        },
        async set() {},
      } },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    },
  });
  const load = (file, context) => vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file });
  load("background.js", background);

  let run;
  const bridgeWindow = {
    location: { origin: "https://web.telegram.org" },
    addEventListener(_type, fn) { pageMessage.addListener(fn); },
    postMessage(message) { if (message.source === "tg-dl-cmd") run.command(message.action); },
  };
  const bridge = vm.createContext({
    window: bridgeWindow, crypto: { randomUUID: () => "test-bridge" }, console,
    chrome: { runtime: {
      onMessage: contentMessage,
      async sendMessage(message) { backgroundMessage.emit(message, sender); },
    } },
  });
  load("content.js", bridge);
  return {
    sentCommands,
    restore(data) { restore(data); },
    pageSend(message, origin = bridgeWindow.location.origin, source = bridgeWindow) {
      pageMessage.emit({ source, origin, data: message });
    },
    setTime(value) { now = value; },
    tick(value) {
      now = value;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
    },
    state() { return structuredClone(vm.runInContext("downloads", background)); },
    send(message, owner = sender) { backgroundMessage.emit(message, owner); },
    start(responses) {
      run = harness(responses, {}, { Date: Clock, onMessage(message) {
        pageMessage.emit({ source: bridgeWindow, origin: bridgeWindow.location.origin, data: message });
      } });
      return run;
    },
    popup() {
      const port = { name: "popup", onMessage: event(), onDisconnect: event(), postMessage() {} };
      connects.emit(port);
      return { command(action, id) { port.onMessage.emit({ action, id }); } };
    },
  };
}

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

test("header activity waits for restored state then preserves popup cancellation", async () => {
  const app = integration({ delayRestore: true, deliverCommands: false });
  const id = "dl_0_abcdef";
  app.setTime(35000);
  app.pageSend({ source: "tg-dl", type: "dl-activity", id });
  assert.equal(app.state()[id], undefined);
  // Keep restoration pending across a full turn; Promise.resolve is not a barrier.
  await new Promise((resolve) => setImmediate(resolve));
  app.restore({ downloads: { [id]: persistedDownload(id) } });
  await waitFor(() => app.state()[id]?.updatedAt === 35000);
  app.setTime(36000);
  const popup = app.popup();
  assert.equal(app.state()[id].status, "active");
  assert.equal(app.state()[id].offset, 0);
  popup.command("cancel", id);
  assert.equal(app.sentCommands.at(-1).action, "cancel");
});

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
