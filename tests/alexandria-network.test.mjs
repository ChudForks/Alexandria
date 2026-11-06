import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../plugins/alexandria/index.jsx", import.meta.url), "utf8");
const start = source.indexOf("async function captureSentMessage(");
const end = source.indexOf("function formatDate(", start);
assert.ok(start >= 0 && end > start, "The sent-message interceptor must be present");
const interceptorSource = source.slice(start, end);

function harness(overrides = {}) {
  const captured = [];
  const errors = [];
  const context = vm.createContext({
    pluginUnloading: false,
    archiveClearing: false,
    asString: (value) => String(value ?? ""),
    pendingMessages: new Map(),
    entries: () => [],
    historyEntry: () => null,
    messageFromPayload: (body) => body?.id ? body : null,
    channelIdFromUrl: (url) => url?.match(/\/channels\/(\d+)\/messages/)?.[1] || "",
    rememberMessage: (message) => captured.push(message),
    console: { error: (...args) => errors.push(args) },
    ...overrides,
  });
  vm.runInContext(`${interceptorSource}\nglobalThis.intercept = captureSentMessage;`, context);
  return { context, captured, errors, intercept: context.intercept };
}

test("sent-message capture sends once, captures the channel, and returns the exact response", async () => {
  const h = harness();
  const request = { url: "/channels/123/messages" };
  const response = { ok: true, body: { id: "456", content: "Sent" } };
  const sent = [];
  const result = await h.intercept(request, async (value) => {
    sent.push(value);
    return response;
  });
  assert.equal(result, response);
  assert.deepEqual(sent, [request]);
  assert.equal(h.captured.length, 1);
  assert.equal(h.captured[0].channel_id, "123");
  assert.equal(h.captured[0].content, "Sent");
});

for (const location of ["pending", "archive", "history"]) {
  test(`a delayed send response preserves a newer ${location} snapshot`, async () => {
    const pending = new Map();
    const archive = [];
    const history = new Map();
    const h = harness({
      pendingMessages: pending,
      entries: () => archive,
      historyEntry: (id) => history.get(id),
    });
    const response = { ok: true, body: { id: 456, content: "Original sent text" } };
    let finish;
    const result = h.intercept({ url: "/channels/123/messages" }, () => new Promise((resolve) => { finish = resolve; }));
    const snapshot = { id: "456", content: "Newer edit", attachments: [{ id: "new-file" }] };
    if (location === "pending") pending.set(snapshot.id, snapshot);
    else if (location === "archive") archive.push(snapshot);
    else history.set(snapshot.id, snapshot);
    finish(response);

    assert.equal(await result, response);
    assert.equal(h.captured.length, 0, "Do not recapture stale text or restart photo downloads");
    const retained = location === "pending" ? pending.get(snapshot.id) : location === "archive" ? archive[0] : history.get(snapshot.id);
    assert.equal(retained, snapshot);
    assert.equal(retained.content, "Newer edit");
    assert.equal(h.errors.length, 0);
  });
}

for (const boundary of ["messageFromPayload", "rememberMessage"]) {
  test(`a ${boundary} failure cannot reject a successful send`, async () => {
    const failure = new Error("Local capture/storage failure");
    const h = harness({ [boundary]: () => { throw failure; } });
    const response = { ok: true, body: { id: "456", channel_id: "789" } };
    let sendCount = 0;
    assert.equal(await h.intercept({ url: "/channels/123/messages" }, async () => {
      sendCount++;
      return response;
    }), response);
    assert.equal(sendCount, 1);
    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0][1], failure);
  });
}

test("send errors propagate unchanged without attempting capture", async () => {
  const h = harness();
  const failure = new Error("Discord send failed");
  let sendCount = 0;
  await assert.rejects(h.intercept({ url: "/channels/123/messages" }, async () => {
    sendCount++;
    throw failure;
  }), (error) => error === failure);
  assert.equal(sendCount, 1);
  assert.equal(h.captured.length, 0);
  assert.equal(h.errors.length, 0);
});

for (const flag of ["pluginUnloading", "archiveClearing"]) {
  test(`a send completing during ${flag} returns its response without capture`, async () => {
    const h = harness();
    const response = { ok: true, body: { id: "456" } };
    let finish;
    const result = h.intercept({ url: "/channels/123/messages" }, () => new Promise((resolve) => { finish = resolve; }));
    h.context[flag] = true;
    finish(response);
    assert.equal(await result, response);
    assert.equal(h.captured.length, 0);
  });
}
