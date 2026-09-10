const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function popup() {
  class Element {
    constructor() {
      this.children = []; this.dataset = {}; this.style = {}; this.attrs = {};
      this.listeners = {}; this.textContent = "";
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    appendChild(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    closest() { return this; }
  }
  const elements = Object.fromEntries(["list", "empty", "clearBtn"].map((id) => [id, new Element()]));
  let receive;
  let broken = false;
  const sent = [];
  const port = { postMessage(msg) { if (broken) throw new Error("disconnected"); sent.push(msg); },
    onMessage: { addListener(fn) { receive = fn; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8"), {
    document: { getElementById: (id) => elements[id], createElement: () => new Element(),
      createDocumentFragment: () => new Element() },
    chrome: { runtime: { connect: () => port } },
  });
  function all(node) { return [node, ...node.children.flatMap(all)]; }
  return { elements, sent, port, receive: (msg) => receive(msg), breakPort() { broken = true; },
    actions: () => all(elements.list).filter((node) => node.dataset.action),
    click(button) { elements.list.listeners.click({ target: button }); } };
}
const failed = { id: "dl_0_abcdef", filename: "test.mp4", status: "error", error: "offline", pct: 0 };

test("failed row places keyboard-accessible Retry immediately before X", () => {
  const app = popup();
  app.receive({ type: "state-snapshot", downloads: { [failed.id]: failed } });
  assert.deepEqual(app.actions().map((n) => n.dataset.action), ["retry", "delete"]);
  const [retry, remove] = app.actions();
  assert.equal(retry.type, "button");
  assert.equal(retry.textContent, "Retry");
  assert.match(retry.attrs["aria-label"], /beginning/);
  app.click(retry);
  assert.equal(app.sent[0].action, "retry");
  app.click(remove);
  assert.equal(app.sent[1].action, "delete");
  assert.equal(app.actions().length, 2, "do not optimistically hide failed deletion");
  app.receive({ type: "dl-delete", id: failed.id });
  assert.equal(app.actions().length, 0);
});

test("retry-in-flight disables Retry and hides X; active rows retain pause/cancel", () => {
  const app = popup();
  app.receive({ type: "dl-update", download: { ...failed, retrying: true } });
  assert.deepEqual(app.actions().map((n) => n.dataset.action), ["retry"]);
  assert.equal(app.actions()[0].disabled, true);
  app.receive({ type: "dl-update", download: { ...failed, status: "active" } });
  assert.deepEqual(app.actions().map((n) => n.dataset.action), ["pause", "cancel"]);
});

test("disconnected popup keeps record and shows reconnection instructions", () => {
  const app = popup();
  app.receive({ type: "dl-update", download: failed });
  app.breakPort();
  app.click(app.actions()[1]);
  assert.equal(app.actions().length, 2);
  assert.match(app.elements.empty.textContent, /Close and reopen/);
});
