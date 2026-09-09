const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Execute the actual MAIN-world script, with no network or real file saves.
const source = fs.readFileSync(path.join(__dirname, "../downloader.js"), "utf8");
const origin = "https://web.telegram.org";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(status, range, body, headers = {}) {
  return {
    status,
    headers: new Headers({ ...(range == null ? {} : { "Content-Range": range }), ...headers }),
    blob: async () => new Blob([body]),
  };
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Download did not reach the expected state");
}

function harness(responses, callbacks = {}, environment = {}) {
  const messages = [];
  const requests = [];
  const saves = [];
  const timers = [];
  const revokedUrls = [];
  const callbackEvents = [];
  const listeners = [];
  let objectBlob;
  const window = {
    location: { origin },
    addEventListener(_type, listener) { listeners.push(listener); },
    postMessage(message) {
      messages.push(message);
      environment.onMessage?.(message);
    },
  };
  const context = {
    window, Blob, AbortController, Date: environment.Date || Date,
    console: { log() {}, error() {} },
    // Record timers for deterministic execution instead of sleeping in tests.
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    URL: {
      createObjectURL(blob) { objectBlob = blob; return "blob:mock"; },
      revokeObjectURL(url) { revokedUrls.push(url); },
    },
    document: {
      body: { appendChild() {} },
      createElement() {
        return { click() { saves.push(objectBlob); }, remove() {} };
      },
    },
    fetch: async (url, options) => {
      const index = requests.length;
      requests.push({ url, ...options });
      if (index >= responses.length) throw new Error("Unexpected extra request");
      const next = responses[index];
      return typeof next === "function" ? next(options) : next;
    },
  };
  vm.runInNewContext(source, context, { filename: "downloader.js" });
  const opts = { key: "doc:123" };
  for (const name of ["onProgress", "onComplete", "onError", "onCancel"]) {
    opts[name] = (...args) => {
      callbackEvents.push({ name, args });
      callbacks[name]?.(...args);
    };
  }
  const id = window.__TG_DL(origin + "/progressive/document123", opts);
  return {
    id, window, messages, requests, saves, callbackEvents, timers, revokedUrls,
    statuses: (type) => messages.filter((message) => message.type === type),
    command(action) {
      for (const listener of listeners) {
        listener({ source: window, origin, data: { source: "tg-dl-cmd", action, id } });
      }
    },
    async settled() {
      await waitFor(() => messages.some((message) =>
        ["dl-complete", "dl-error", "dl-cancel"].includes(message.type)));
      // Allow finally() and any wrongly scheduled next fetch to run as well.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function assertTerminal(run, type) {
  const terminal = run.messages.filter((message) =>
    ["dl-complete", "dl-error", "dl-cancel"].includes(message.type));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, type);
  assert.equal(Object.keys(run.window.__TG_DL_ACTIVE).length, 0);
  if (type !== "dl-complete") assert.equal(run.saves.length, 0);
}

module.exports = { harness, response, deferred, waitFor, assertTerminal };
