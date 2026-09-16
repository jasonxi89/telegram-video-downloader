const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function popup() {
  let createdElements = 0;
  const frames = [];
  class Element {
    constructor(fragment = false) {
      createdElements++;
      this.fragment = fragment;
      this.children = []; this.dataset = {}; this.style = {}; this.attrs = {};
      this.listeners = {}; this.textContent = "";
      this.parentNode = null;
      this.className = "";
      const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
      this.classList = {
        add: (...names) => {
          const next = classes();
          for (const name of names) next.add(name);
          this.className = [...next].join(" ");
        },
        remove: (...names) => {
          const next = classes();
          for (const name of names) next.delete(name);
          this.className = [...next].join(" ");
        },
        contains: (name) => classes().has(name),
        toggle: (name, force) => {
          const add = force === undefined ? !classes().has(name) : force;
          this.classList[add ? "add" : "remove"](name);
          return add;
        },
      };
    }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() {
      return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null;
    }
    appendChild(child) { return this.insertBefore(child, null); }
    insertBefore(child, next) {
      if (child.fragment) {
        for (const node of [...child.children]) this.insertBefore(node, next);
        return child;
      }
      if (child === next) return child;
      child.remove();
      const index = next ? this.children.indexOf(next) : this.children.length;
      assert.ok(index >= 0, "insertion reference belongs to the parent");
      this.children.splice(index, 0, child);
      child.parentNode = this;
      return child;
    }
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    }
    replaceChildren(...children) {
      for (const child of [...this.children]) child.remove();
      for (const child of children) this.appendChild(child);
    }
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
      createDocumentFragment: () => new Element(true) },
    chrome: { runtime: { connect: () => port } },
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
  });
  function all(node) { return [node, ...node.children.flatMap(all)]; }
  function flush() { for (const frame of frames.splice(0)) frame(); }
  return { elements, sent, port, receive: (msg) => { receive(msg); flush(); },
    queue: (msg) => receive(msg), flush, pendingFrames: () => frames.length,
    createdElements: () => createdElements, breakPort() { broken = true; },
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
  assert.equal(app.elements.empty.classList.contains("hidden"), false);
});

test("a queued progress frame cannot hide a later connection error", () => {
  const app = popup();
  const active = { ...failed, status: "active", total: 100, pct: 1 };
  app.receive({ type: "state-snapshot", downloads: { [active.id]: active } });
  app.queue({ type: "dl-update", download: { ...active, pct: 2 } });
  app.breakPort();
  app.click(app.actions()[0]);
  assert.equal(app.elements.empty.classList.contains("hidden"), false);
  app.flush();
  assert.equal(app.elements.empty.classList.contains("hidden"), false);
  assert.match(app.elements.empty.textContent, /Close and reopen/);
  assert.equal(app.elements.list.firstChild.children[1].attrs["aria-valuenow"], "2");
});

test("progress preserves action buttons and does not rebuild download history", () => {
  const app = popup();
  const active = { ...failed, status: "active", offset: 0, total: 100 };
  const history = Object.fromEntries(Array.from({ length: 500 }, (_, i) => {
    const id = `dl_${i + 1}_abcdef`;
    return [id, { ...failed, id, status: "complete", pct: 100 }];
  }));
  app.receive({ type: "state-snapshot", downloads: { ...history, [active.id]: active } });
  const buttons = app.actions();
  const rows = [...app.elements.list.children];
  const created = app.createdElements();
  app.receive({ type: "dl-update", download: { ...active, offset: 50, pct: 50 } });
  assert.equal(app.createdElements(), created, "a progress event needs no new elements");
  app.actions().forEach((button, i) => assert.equal(button, buttons[i]));
  app.elements.list.children.forEach((row, i) => assert.equal(row, rows[i]));
  assert.equal(rows[0].children[1].attrs["aria-valuenow"], "50");
  app.click(buttons[0]);
  assert.equal(app.sent[0].action, "pause");
});

test("a progress burst renders the newest state in one frame, including deletions", () => {
  const app = popup();
  const active = { ...failed, status: "active", total: 100 };
  app.receive({ type: "state-snapshot", downloads: { [active.id]: active } });
  for (let pct = 1; pct <= 20; pct++) {
    app.queue({ type: "dl-update", download: { ...active, pct, offset: pct } });
  }
  assert.equal(app.pendingFrames(), 1);
  app.flush();
  assert.equal(app.elements.list.firstChild.children[1].attrs["aria-valuenow"], "20");
  app.queue({ type: "dl-update", download: { ...active, pct: 30, offset: 30 } });
  app.queue({ type: "dl-delete", id: active.id });
  app.flush();
  assert.equal(app.elements.list.children.length, 0);
  assert.equal(app.actions().length, 0);
});

test("freshly serialized snapshots reuse history nodes and update changed fields", () => {
  const app = popup();
  const active = { ...failed, status: "active", offset: 0, total: 100 };
  const history = Object.fromEntries(Array.from({ length: 500 }, (_, i) => {
    const id = `dl_${i + 1}_abcdef`;
    return [id, { ...failed, id, status: "complete", pct: 100 }];
  }));
  const downloads = { ...history, [active.id]: active };
  const snapshot = () => app.receive(JSON.parse(JSON.stringify({ type: "state-snapshot", downloads })));
  snapshot();
  const buttons = app.actions();
  const created = app.createdElements();
  downloads[active.id] = { ...active, filename: "renamed.mp4", offset: 25, pct: 25 };
  snapshot();
  snapshot();
  assert.equal(app.createdElements(), created);
  app.actions().forEach((button, i) => assert.equal(button, buttons[i]));
  const row = app.elements.list.firstChild;
  assert.equal(row.children[0].children[0].textContent, "renamed.mp4");
  assert.equal(row.children[1].attrs["aria-valuenow"], "25");
});

test("unchanged controls still show and clear command and activity feedback", () => {
  const app = popup();
  const active = { ...failed, status: "active", total: 100, offset: 50, pct: 50 };
  app.receive({ type: "dl-update", download: active });
  const row = app.elements.list.firstChild;
  const pause = app.actions()[0];
  const created = app.createdElements();
  app.receive({ type: "dl-update", download: { ...active, commandError: "Pause was not confirmed by the page" } });
  assert.match(row.children[2].textContent, /⚠ Pause was not confirmed/);
  app.receive({ type: "dl-update", download: { ...active, activityWarning: "No recent progress" } });
  assert.match(row.children[2].textContent, /No recent progress/);
  assert.doesNotMatch(row.children[2].textContent, /Pause was not confirmed/);
  app.receive({ type: "dl-update", download: { ...active } });
  assert.doesNotMatch(row.children[2].textContent, /No recent progress|Pause was not confirmed/);
  assert.equal(app.actions()[0], pause);
  assert.equal(app.createdElements(), created);
});

test("snapshots reconcile removals and state changes without duplicating rows", () => {
  const app = popup();
  const active = { ...failed, id: "dl_2_abcdef", status: "active" };
  app.receive({ type: "state-snapshot", downloads: { [failed.id]: failed, [active.id]: active } });
  assert.deepEqual(app.elements.list.children.map((row) => row.dataset.id), [active.id, failed.id]);
  app.receive({ type: "dl-update", download: { ...active, status: "complete" } });
  assert.deepEqual(app.elements.list.children.map((row) => row.dataset.id), [failed.id, active.id]);
  app.receive({ type: "state-snapshot", downloads: { [active.id]: { ...active, status: "paused" } } });
  assert.deepEqual(app.elements.list.children.map((row) => row.dataset.id), [active.id]);
  assert.deepEqual(app.actions().map((button) => button.dataset.action), ["resume", "cancel"]);
});
