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
function integration({ deliverCommands = true, delayRestore = false, badgeThrows = false, delayWrites = false } = {}) {
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
  const storageWrites = [];
  const pendingWrites = [];
  let persisted = {};
  const popupMessages = [];
  const background = vm.createContext({
    URL, Date: Clock, console: { ...console, error() {}, warn() {} },
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
        set(data) {
          const snapshot = structuredClone(data);
          storageWrites.push(snapshot);
          const commit = () => Object.assign(persisted, snapshot);
          if (delayWrites) return new Promise((resolve, reject) => {
            pendingWrites.push({ resolve() { commit(); resolve(); }, reject });
          });
          commit();
          return Promise.resolve();
        },
      } },
      action: {
        setBadgeText() { if (badgeThrows) throw new Error("badge unavailable"); },
        setBadgeBackgroundColor() {},
      },
    },
  });
  const load = (file, context) => vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file });
  background.importScripts = (file) => load(file, background);
  load("background.js", background);

  let run;
  const bridgeWindow = {
    location: { origin: "https://web.telegram.org" },
    addEventListener(_type, fn) { pageMessage.addListener(fn); },
    postMessage(message) { if (message.source === "tg-dl-cmd") run.command(message.action, message); },
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
    sentCommands, storageWrites, popupMessages,
    restore(data) { persisted = structuredClone(data || {}); restore(data); },
    persisted() { return structuredClone(persisted); },
    settle() { return new Promise(resolve => setImmediate(resolve)); },
    finishWrite(error) {
      const write = pendingWrites.shift();
      if (!write) throw new Error("No pending storage write");
      if (error) write.reject(error); else write.resolve();
    },
    pendingWrites() { return pendingWrites.length; },
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
    start(responses, { workerRestarted = false } = {}) {
      run = harness(responses, {}, { Date: Clock, onMessage(message) {
        // A restarted worker did not receive the original page-side dl-start.
        if (workerRestarted && message.type === "dl-start") return;
        pageMessage.emit({ source: bridgeWindow, origin: bridgeWindow.location.origin, data: message });
      } });
      return run;
    },
    popup() {
      const port = { name: "popup", onMessage: event(), onDisconnect: event(),
        postMessage(message) { popupMessages.push(structuredClone(message)); } };
      connects.emit(port);
      return { command(action, id) { port.onMessage.emit({ action, id }); },
        disconnect() { port.onDisconnect.emit(); } };
    },
  };
}

module.exports = { integration };
