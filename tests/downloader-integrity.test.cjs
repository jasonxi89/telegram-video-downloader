const test = require("node:test");
const assert = require("node:assert/strict");
const { harness, response, deferred, waitFor, assertTerminal } = require("./downloader-harness.cjs");

const firstChunk = () => response(206, "bytes 0-2/6", "abc");
const lastChunk = () => response(206, "bytes 3-5/6", "def");

async function assertSaved(run, expected) {
  await run.settled();
  assertTerminal(run, "dl-complete");
  assert.equal(run.saves.length, 1);
  assert.equal(await run.saves[0].text(), expected);
  assert.equal(run.statuses("dl-complete")[0].total, expected.length);
}

test("continuous 206 chunks preserve bytes, ranges and measured progress", async () => {
  const run = harness([firstChunk(), lastChunk()]);
  await assertSaved(run, "abcdef");
  assert.deepEqual(run.requests.map((r) => r.headers.Range), ["bytes=0-", "bytes=3-"]);
  assert.deepEqual(run.statuses("dl-progress").map((m) => [m.offset, m.total, m.pct]),
    [[3, 6, 50], [6, 6, 100]]);
});

for (const length of [undefined, "6"]) {
  test(`first 200 full response supports Content-Length ${length}`, async () => {
    const headers = length === undefined ? {} : { "Content-Length": length };
    const run = harness([response(200, null, "abcdef", headers)]);
    await assertSaved(run, "abcdef");
    assert.equal(run.requests.length, 1);
    assert.equal(run.statuses("dl-progress")[0].offset, 6);
  });
}

const invalid = [
  ["mid-download 200", [firstChunk(), response(200, null, "abcdef")]],
  ["missing range", [response(206, null, "abc")]],
  ["malformed range", [response(206, "invalid", "abc")]],
  ["unknown total", [response(206, "bytes 0-2/*", "abc")]],
  ["first range starts after zero", [response(206, "bytes 1-3/6", "bcd")]],
  ["gap", [firstChunk(), response(206, "bytes 4-5/6", "ef")]],
  ["overlap", [firstChunk(), response(206, "bytes 2-5/6", "cdef")]],
  ["repeated range", [firstChunk(), firstChunk()]],
  ["reversed range", [response(206, "bytes 0-2/6", "abc"), response(206, "bytes 3-2/6", "")]],
  ["end reaches total", [response(206, "bytes 0-6/6", "abcdefg")]],
  ["zero total", [response(206, "bytes 0-0/0", "a")]],
  ["changed total", [firstChunk(), response(206, "bytes 3-6/7", "defg")]],
  ["unsafe integer", [response(206, "bytes 0-2/9007199254740992", "abc")]],
  ["short range body", [response(206, "bytes 0-2/6", "ab")]],
  ["long range body", [response(206, "bytes 0-2/6", "abcd")]],
  ["empty range body", [response(206, "bytes 0-2/6", "")]],
  ["200 with Content-Range", [response(200, "bytes 0-2/6", "abc")]],
  ["200 short body", [response(200, null, "abc", { "Content-Length": "6" })]],
  ["200 empty video", [response(200, null, "")]],
  ["200 malformed length", [response(200, null, "abc", { "Content-Length": "3x" })]],
  ["200 unsafe length", [response(200, null, "abc", { "Content-Length": "9007199254740992" })]],
  ["encoded partial response", [response(206, "bytes 0-2/6", "abc", { "Content-Encoding": "gzip" })]],
  ["HTTP 416", [response(416, null, "")]],
];
for (const [name, responses] of invalid) {
  test(`reject ${name} without saving or advancing invalid progress`, async () => {
    const run = harness(responses);
    await run.settled();
    assertTerminal(run, "dl-error");
    assert.equal(run.requests.length, responses.length);
    assert.equal(run.statuses("dl-progress").length, responses.length - 1);
    assert.equal(run.callbackEvents.filter((e) => e.name === "onError").length, 1);
    assert.equal(run.callbackEvents.filter((e) => e.name === "onComplete").length, 0);
    assert(run.requests.at(-1).signal.aborted, "invalid response must release its fetch");
  });
}

test("body read failure cannot advance progress or save", async () => {
  const res = firstChunk();
  res.blob = async () => { throw new Error("body disconnected"); };
  const run = harness([res]);
  await run.settled();
  assertTerminal(run, "dl-error");
  assert.equal(run.statuses("dl-progress").length, 0);
});

test("headers alone never report bytes; next fetch waits for the body", async () => {
  const body = deferred();
  let reading = false;
  const res = firstChunk();
  res.blob = () => { reading = true; return body.promise; };
  const run = harness([res, lastChunk()]);
  await waitFor(() => reading);
  assert.equal(run.statuses("dl-progress").length, 0);
  assert.equal(run.requests.length, 1);
  body.resolve(new Blob(["abc"]));
  await assertSaved(run, "abcdef");
});

test("pause drains the in-flight chunk; repeated resume stays sequential", async () => {
  const body = deferred();
  let reading = false;
  const res = firstChunk();
  res.blob = () => { reading = true; return body.promise; };
  const run = harness([res, lastChunk()]);
  await waitFor(() => reading);
  run.command("pause");
  run.command("resume");
  run.command("resume");
  assert.equal(run.requests.length, 1);
  run.command("pause");
  body.resolve(new Blob(["abc"]));
  await waitFor(() => run.window.__TG_DL_ACTIVE[run.id]?.inFlight === false);
  assert.equal(run.requests.length, 1);
  assert.equal(run.saves.length, 0);
  assert.equal(run.statuses("dl-progress")[0].offset, 3);
  run.command("resume");
  run.command("resume");
  await assertSaved(run, "abcdef");
  assert.equal(run.requests.length, 2);
});

test("cancel during body read suppresses late progress, next fetch and save", async () => {
  const body = deferred();
  let reading = false;
  const res = firstChunk();
  res.blob = () => { reading = true; return body.promise; };
  const run = harness([res, lastChunk()]);
  await waitFor(() => reading);
  run.command("cancel");
  run.command("cancel");
  body.resolve(new Blob(["abc"]));
  await run.settled();
  assertTerminal(run, "dl-cancel");
  assert(run.requests[0].signal.aborted);
  assert.equal(run.statuses("dl-progress").length, 0);
  assert.equal(run.requests.length, 1);
  assert.deepEqual(run.callbackEvents.map((e) => e.name), ["onCancel"]);
});

test("first encoded 200 uses decoded body size, not encoded Content-Length", async () => {
  const run = harness([response(200, null, "abcdef", {
    "Content-Encoding": "gzip", "Content-Length": "26",
  })]);
  await assertSaved(run, "abcdef");
  assert.equal(run.statuses("dl-progress")[0].total, 6);
});

test("cancel before headers suppresses body read and all progress", async () => {
  const headers = deferred();
  let reads = 0;
  const res = firstChunk();
  res.blob = async () => { reads++; return new Blob(["abc"]); };
  const run = harness([() => headers.promise]);
  run.command("cancel");
  headers.resolve(res);
  await run.settled();
  assertTerminal(run, "dl-cancel");
  assert.equal(reads, 0);
  assert.equal(run.statuses("dl-progress").length, 0);
});

test("cancel from final progress callback cannot save or report complete", async () => {
  let run;
  run = harness([response(200, null, "abcdef")], {
    onProgress() { run.command("cancel"); },
  });
  await run.settled();
  assertTerminal(run, "dl-cancel");
});

test("network rejection reports one error and releases registry", async () => {
  const run = harness([() => Promise.reject(new Error("offline"))]);
  await run.settled();
  assertTerminal(run, "dl-error");
  assert.equal(run.statuses("dl-progress").length, 0);
});

test("UI callback failures do not suppress successful engine completion", async () => {
  const fail = () => { throw new Error("detached UI"); };
  const run = harness([firstChunk(), lastChunk()], { onProgress: fail, onComplete: fail });
  await assertSaved(run, "abcdef");
});
