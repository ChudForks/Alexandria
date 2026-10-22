import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../plugins/alexandria/index.jsx", import.meta.url), "utf8");
// Execute the actual non-JSX plugin code, not a copy of its implementation.
// UI rendering is excluded; browser/Shelter boundaries are modeled below.
const core = source.slice(source.indexOf("const {"), source.indexOf("function SearchablePicker"));
const clear = source.slice(source.indexOf("async function clearArchive"), source.indexOf("function clampLauncherPosition"));
const load = source.slice(source.indexOf("export function onLoad"), source.indexOf("function CaptureExclusionSettings")).replace("export ", "");
const unload = source.slice(source.indexOf("export function onUnload")).replace("export ", "");

function fakeIndexedDB(blobs, historyRows) {
  const stores = new Map([["photos", blobs]]);
  const database = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore: (name) => stores.set(name, historyRows),
    close() {},
    transaction(name) {
      const records = stores.get(name);
      assert.ok(records, `Missing IndexedDB store ${name}`);
      let pending = 0;
      const transaction = {
        objectStore() {
          const request = (operation) => {
            const result = {};
            pending++;
            queueMicrotask(() => {
              result.result = operation();
              result.onsuccess?.();
              pending--;
              queueMicrotask(() => { if (!pending) transaction.oncomplete?.(); });
            });
            return result;
          };
          return {
            get: (key) => request(() => structuredClone(records.get(key))),
            getAllKeys: () => request(() => [...records.keys()]),
            getAll: () => request(() => structuredClone([...records.values()])),
            put: (value, key) => {
              const clone = structuredClone(value);
              return request(() => records.set(key, clone));
            },
            delete: (key) => request(() => records.delete(key)),
            clear: () => request(() => records.clear()),
          };
        },
      };
      queueMicrotask(() => { if (!pending) transaction.oncomplete?.(); });
      return transaction;
    },
  };
  return {
    open() {
      const request = { result: database };
      queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); });
      return request;
    },
  };
}

function fakeElement(message) {
  let mutations = 0;
  const attributes = new Map();
  const classes = new Set();
  const element = {
    message,
    dataset: new Proxy({}, {
      set(target, key, value) { mutations++; target[key] = value; return true; },
      deleteProperty(target, key) { mutations++; delete target[key]; return true; },
    }),
    classList: {
      contains: (name) => classes.has(name),
      add(name) { mutations++; classes.add(name); },
      remove(name) { mutations++; classes.delete(name); },
    },
    getAttribute: (name) => attributes.get(name) ?? null,
    hasAttribute: (name) => attributes.has(name),
    setAttribute(name, value) { mutations++; attributes.set(name, value); },
    removeAttribute(name) { mutations++; attributes.delete(name); },
    closest: () => element,
    querySelectorAll: () => [],
    get mutations() { return mutations; },
  };
  for (const name of ["src", "srcset", "href"]) {
    Object.defineProperty(element, name, {
      get: () => attributes.get(name) || "",
      set: (value) => { mutations++; attributes.set(name, value); },
    });
  }
  return element;
}

const photo = (id = "photo-a") => ({
  id, filename: `${id}.png`, content_type: "image/png", size: 8,
  url: `https://original.example/attachments/${id}/${id}.png`,
  proxy_url: `https://proxy.example/attachments/${id}/${id}.png`,
  width: 32, height: 32,
});
const message = (id = "message-a", extra = {}) => ({
  id, channel_id: "100", guild_id: "10", content: "Original content",
  author: { id: "author-a", username: "alice", global_name: "Alice" },
  timestamp: "2026-09-01T12:00:00.000Z", attachments: [], embeds: [], ...extra,
});
const response = () => ({
  ok: true, headers: new Headers({ "content-type": "image/png" }),
  blob: async () => new Blob(["12345678"], { type: "image/png" }),
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function harness(options = {}) {
  const blobs = options.disk?.blobs || new Map();
  const historyRows = options.disk?.historyRows || new Map();
  const messages = new Map();
  const rows = new Map();
  const urls = new Set();
  const dispatches = [];
  const requests = [];
  const httpRequests = [];
  const httpInterceptors = [];
  const errors = [];
  const disposers = [];
  const observers = new Set();
  const timers = new Map();
  const timerDelays = new Map();
  const clock = options.clock || { now: Date.now() };
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  let nextTimer = 0;
  let nextUrl = 0;
  const store = { archiveSchemaVersion: 2, ...options.store };
  const location = { pathname: "/channels/10/100" };
  const document = {
    getElementById: (id) => rows.get(id) || null,
    querySelectorAll(selector) {
      const elements = [...new Set(rows.values())];
      if (selector === ".alexandria-deleted-message") return elements.filter((row) => row.classList.contains(selector.slice(1)));
      if (selector === '[data-alexandria-live-photo="true"]') return elements.filter((row) => row.dataset.alexandriaLivePhoto === "true");
      if (selector.startsWith('[id^="message-username-"],')) return elements;
      return [];
    },
    addEventListener() {}, removeEventListener() {},
  };
  const scoped = {
    onDispose: (dispose) => disposers.push(dispose),
    observeDom(selector, callback) {
      observers.add(callback);
      const stop = () => observers.delete(callback);
      stop.now = stop; // Shelter's .now() cancels; it does not scan the DOM.
      return stop;
    },
    flux: { intercept: () => () => {} },
    http: { intercept: (method, filter, callback) => {
      const interceptor = { method, filter, callback };
      httpInterceptors.push(interceptor);
      return () => httpInterceptors.splice(httpInterceptors.indexOf(interceptor), 1);
    } },
  };
  class ObjectURL extends URL {
    static createObjectURL() { const url = `blob:test-${++nextUrl}`; urls.add(url); return url; }
    static revokeObjectURL(url) { urls.delete(url); }
  }
  const context = vm.createContext({
    shelter: {
      plugin: { store, scoped },
      ui: { openConfirmationModal: options.confirm || (async () => {}) },
      util: { getProps: (element) => ({ message: element.message }), getFiber: () => null, reactFiberWalker: () => null },
      http: { ready: Promise.resolve(), get: async (request) => {
        httpRequests.push(request);
        const send = () => options.httpGet ? options.httpGet(request) : { ok: true, body: [] };
        const interceptor = httpInterceptors.find((item) => item.method === "get" && item.filter(request.url));
        return interceptor ? interceptor.callback(request, send) : send();
      } },
      flux: {
        storesFlat: {
          ChannelStore: {
            getChannel: (id) => options.channels ? options.channels.find((channel) => channel.id === id) :
              ({ id, name: `channel-${id}`, type: id.startsWith("3") ? 1 : 0, guild_id: id === "200" ? "20" : id.startsWith("3") ? "" : "10" }),
            getMutableGuildChannelsForGuild: (guildId) => (options.channels || []).filter((channel) => channel.guild_id === guildId),
          },
          PermissionStore: options.permissions,
          GuildStore: { getGuild: (id) => ({ id, name: `guild-${id}` }) },
          SelectedChannelStore: { getChannelId: () => location.pathname.split("/").at(-1) },
          MessageStore: {
            getMessage: (channelId, id) => messages.get(id)?.channel_id === channelId ? messages.get(id) : null,
            getMessages: (channelId) => ({ _array: [...messages.values()].filter((value) => value.channel_id === channelId) }),
          },
        },
        dispatcher: { dispatch(payload) {
          dispatches.push(payload);
          if (payload.alexandriaRemove) {
            // Discord's internal Flux action uses channelId, unlike the raw
            // Gateway's channel_id. A mismatched shape must not remove a row.
            assert.equal(typeof payload.channelId, "string", "Synthetic deletes need Discord's Flux channelId");
            const stored = messages.get(payload.id);
            if (stored?.channel_id === payload.channelId) messages.delete(payload.id);
            for (const [id, row] of rows) {
              if (row.message?.id === payload.id && row.message?.channel_id === payload.channelId) rows.delete(id);
            }
          }
          return options.dispatch?.(payload);
        } },
      },
    },
    AbortController, Blob, Date: TestDate, URL: ObjectURL, crypto: webcrypto, indexedDB: fakeIndexedDB(blobs, historyRows), document, location,
    fetch: async (url, init) => { requests.push(url); return options.fetch ? options.fetch(url, init) : response(); },
    window: { addEventListener() {}, removeEventListener() {} },
    console: { error: (...args) => errors.push(args) },
    setTimeout: (callback, delay = 0) => { const id = ++nextTimer; timers.set(id, callback); timerDelays.set(id, delay); return id; },
    clearTimeout: (id) => { timers.delete(id); timerDelays.delete(id); },
    testThumbnail: options.thumbnail || (async (blob) => blob),
  });
  vm.runInContext(`${core}\n${clear}\n${load}\n${unload}\n
    function mountLauncher() {}
    function restoreLauncherPosition() {}
    liveThumbnailBlob = testThumbnail;
    globalThis.api = {
      rememberMessage, markDeleted, handleDispatch, clearArchive, onLoad, onUnload,
      captureRenderedMessage, markRenderedMessageDeleted, applyLivePhotoPreviews,
      cachePhoto, cachePhotos, pendingMessages, visibleDeletedMessages, entries,
      setExperimentalHistoryEnabled, captureHistoryMessages, captureHistoryResponse,
      initializeHistoryCache, refreshHistoryCapture, preloadHistoryChannel, historyEntry,
      historyMessages, historyPreloadChannels,
      idleWork: () => Promise.all([livePreviewWork, historyWork]),
      state: () => ({ activePhotoCaptures, queued: photoCaptureQueue.length,
        pendingMessageBytes, pendingPhotoBytes, visibleDeletedMessageBytes,
        historyMessageBytes, historyLoaded, historyPreloadActive }),
    };`, context, { filename: "alexandria-core.js" });
  const api = context.api;
  return {
    ...api, store, blobs, historyRows, messages, rows, urls, dispatches, requests, httpRequests,
    httpInterceptors, errors, timers, timerDelays, clock, observers, location,
    disk: { blobs, historyRows },
    addRow(value) { const row = fakeElement(value); rows.set(`chat-messages-${value.channel_id}-${value.id}`, row); return row; },
    dispose: () => disposers.forEach((dispose) => dispose()),
    async runHistoryTimer() {
      const timer = [...timers].find(([, callback]) => callback === api.preloadHistoryChannel);
      assert.ok(timer, "Expected scheduled history work");
      const [id, callback] = timer;
      clock.now += timerDelays.get(id);
      timers.delete(id);
      timerDelays.delete(id);
      await callback();
    },
    async idle() {
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
        await api.idleWork();
        if (!api.state().activePhotoCaptures && !api.state().queued) {
          assert.equal(errors.length, 0, "Unexpected plugin error");
          return;
        }
      }
      assert.fail("Photo queue did not become idle");
    },
  };
}

test("recapturing an archived photo preserves its original blob and skips downloads", async () => {
  const h = harness();
  const original = message("saved", { attachments: [photo()] });
  h.rememberMessage(original);
  await h.idle();
  const key = h.pendingMessages.get("saved").attachments[0].blobKey;
  h.messages.set("saved", original);
  assert.equal(h.handleDispatch({ type: "MESSAGE_DELETE", id: "saved", channel_id: "100" }), false);
  await h.idle();
  assert.equal(h.urls.size, 1);
  const staleAttachment = { ...h.store.entries[0].attachments[0], blobKey: undefined };
  h.rememberMessage({ ...original, attachments: [{ ...photo(), proxy_url: "blob:thumbnail" }] });
  h.cachePhotos("saved", [staleAttachment]);
  await h.cachePhoto("saved", staleAttachment);
  await h.idle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.pendingMessages.has("saved"), false);
  assert.equal(h.store.entries[0].attachments[0].blobKey, key);
  assert.equal(await h.blobs.get(key).text(), "12345678");
});

test("with history disabled, explicit empty edits clear content, embeds, attachments, and removed blobs", async () => {
  const h = harness({ store: { logEdits: false, logDeletedAttachments: false } });
  h.rememberMessage(message("edited", { attachments: [photo()], embeds: [{ title: "Old embed" }] }));
  await h.idle();
  h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: "edited", content: "", attachments: [], embeds: [] } });
  await h.idle();
  const entry = h.pendingMessages.get("edited");
  assert.equal(entry.content, "");
  assert.equal(entry.attachments.length, 0);
  assert.equal(entry.embeds.length, 0);
  assert.equal(h.blobs.size, 0);
  assert.equal(h.state().pendingPhotoBytes, 0);
  h.markDeleted("edited", "100");
  assert.equal(h.store.entries[0].content, "");
});

test("partial edits preserve omitted author, timestamp, location, content, and photos", async () => {
  const h = harness();
  h.rememberMessage(message("partial", { attachments: [photo()] }));
  await h.idle();
  const before = h.pendingMessages.get("partial");
  h.rememberMessage({ id: "partial", embeds: [{ title: "New embed" }] });
  await h.idle();
  const after = h.pendingMessages.get("partial");
  for (const key of ["authorId", "author", "username", "timestamp", "channelId", "guildId", "content"]) assert.equal(after[key], before[key], key);
  assert.equal(after.attachments[0].blobKey, before.attachments[0].blobKey);
  assert.equal(after.embeds[0].title, "New embed");
  assert.equal(h.requests.length, 1);
});

test("removing one attachment frees only its blob and updates the byte accounting", async () => {
  const h = harness();
  h.rememberMessage(message("subset", { attachments: [photo("a"), photo("b")] }));
  await h.idle();
  const [a, b] = h.pendingMessages.get("subset").attachments;
  h.rememberMessage({ id: "subset", attachments: [photo("b")] });
  await h.idle();
  assert.equal(h.blobs.has(a.blobKey), false);
  assert.equal(h.blobs.has(b.blobKey), true);
  assert.equal(h.blobs.size, 1);
  assert.equal(h.state().pendingPhotoBytes, 8);
});

for (const failure of ["fetch", "stream"]) {
  test(`a ${failure} exception on the proxy still tries the original URL`, async () => {
    const h = harness({ fetch: async (url) => {
      if (url.startsWith("https://original.example")) return response();
      if (failure === "fetch") throw new Error("Proxy unavailable");
      return { ok: true, headers: new Headers(), body: { getReader: () => ({ read: async () => { throw new Error("Stream failed"); }, releaseLock() {} }) } };
    } });
    h.rememberMessage(message("fallback", { attachments: [photo()] }));
    await h.idle();
    assert.equal(h.requests.length, 2);
    assert.equal(h.blobs.size, 1);
    assert.equal(h.pendingMessages.get("fallback").attachments[0].photoUnavailable, false);
  });
}

test("a photo finishing after deletion attaches to the archive, not the pending cache", async () => {
  const download = deferred();
  const h = harness({ fetch: () => download.promise });
  const original = message("in-flight", { attachments: [photo()] });
  h.rememberMessage(original);
  h.messages.set(original.id, original);
  h.handleDispatch({ type: "MESSAGE_DELETE", id: original.id, channel_id: "100" });
  download.resolve(response());
  await h.idle();
  assert.equal(h.pendingMessages.size, 0);
  assert.equal(h.blobs.size, 1);
  assert.equal(h.blobs.has(h.store.entries[0].attachments[0].blobKey), true);
  assert.equal(h.urls.size, 1);
});

test("removing an attachment during its download does not save an orphan blob", async () => {
  const download = deferred();
  const h = harness({ fetch: () => download.promise });
  h.rememberMessage(message("removed", { attachments: [photo()] }));
  h.rememberMessage({ id: "removed", attachments: [] });
  download.resolve(response());
  await h.idle();
  assert.equal(h.blobs.size, 0);
  assert.equal(h.state().pendingPhotoBytes, 0);
});

test("unknown single and bulk deletes do not occupy slots or evict a saved row", async () => {
  const h = harness();
  h.messages.set("known", message("known"));
  assert.equal(h.handleDispatch({ type: "MESSAGE_DELETE", id: "known", channel_id: "100" }), false);
  assert.equal(h.handleDispatch({ type: "MESSAGE_DELETE", id: "unknown", channel_id: "100" }), undefined);
  for (let batch = 0; batch < 3; batch++) {
    assert.equal(h.handleDispatch({ type: "MESSAGE_DELETE_BULK", channel_id: "100", ids: Array.from({ length: 100 }, (_, i) => `unknown-${batch}-${i}`) }), undefined);
  }
  await h.idle();
  assert.equal(h.visibleDeletedMessages.size, 1);
  assert.equal(h.visibleDeletedMessages.has("known"), true);
  assert.equal(h.store.entries.length, 1);
  assert.equal(h.dispatches.some((item) => item.alexandriaRemove), false);
});

for (const idsKey of ["ids", "messageIds", "messages"]) {
  test(`mixed bulk ${idsKey} deletes forward only unretained IDs without mutating the action`, async () => {
    const h = harness();
    h.messages.set("known", message("known"));
    h.rememberMessage(message("pending-only"));
    const ids = idsKey === "messages" ? [{ id: "known" }, { id: "unknown" }, { id: "pending-only" }] : ["known", "unknown", "pending-only"];
    const action = { type: "MESSAGE_DELETE_BULK", channel_id: "100", [idsKey]: ids, extra: "preserved" };
    const result = h.handleDispatch(action);
    await h.idle();
    assert.equal(result[idsKey].length, 2);
    assert.equal(result[idsKey][0]?.id || result[idsKey][0], "unknown");
    assert.equal(result.extra, "preserved");
    assert.equal(action[idsKey], ids);
    assert.equal(ids.length, 3);
    assert.equal(h.visibleDeletedMessages.size, 1);
    assert.equal(h.store.entries.length, 2);
  });
}

for (const type of ["MESSAGE_DELETE", "MESSAGE_DELETE_BULK"]) {
  test(`${type} archives a previously captured message after changing active servers`, async () => {
    const h = harness({ store: { captureMode: "selected", activeMode: true } });
    h.rememberMessage(message("previous-server"));
    h.location.pathname = "/channels/20/200";
    const payload = { type, channel_id: "100", id: "previous-server", ids: ["previous-server"] };
    assert.equal(h.handleDispatch(payload), undefined);
    await h.idle();
    assert.equal(h.store.entries[0].id, "previous-server");
    assert.equal(h.visibleDeletedMessages.size, 0);
  });
}

test("a failed archive write lets Discord's original deletion continue", () => {
  const h = harness();
  h.messages.set("failed", message("failed"));
  Object.defineProperty(h.store, "entries", { get: () => [], set: () => { throw new Error("Store unavailable"); } });
  assert.equal(h.handleDispatch({ type: "MESSAGE_DELETE", id: "failed", channel_id: "100" }), undefined);
  assert.equal(h.visibleDeletedMessages.size, 0);
});

test("duplicate deletes retain an existing row without replacing its preview URLs", async () => {
  const h = harness();
  const original = message("duplicate", { attachments: [photo()] });
  h.rememberMessage(original);
  h.messages.set(original.id, original);
  await h.idle();
  const payload = { type: "MESSAGE_DELETE", id: original.id, channel_id: "100" };
  assert.equal(h.handleDispatch(payload), false);
  await h.idle();
  const preview = h.visibleDeletedMessages.get(original.id);
  assert.equal(h.handleDispatch(payload), false);
  await h.idle();
  assert.equal(h.visibleDeletedMessages.get(original.id), preview);
  assert.equal(h.urls.size, 1);
  assert.equal(h.dispatches.filter((item) => item.alexandriaCompact).length, 1);
});

test("observation survives startup, captures later DOM messages, and stops on disposal", async () => {
  const h = harness();
  h.addRow(message("already-rendered"));
  h.onLoad();
  assert.equal(h.observers.size, 1);
  assert.equal(h.pendingMessages.has("already-rendered"), true);
  for (const observe of h.observers) observe(fakeElement(message("later-rendered")));
  assert.equal(h.pendingMessages.has("later-rendered"), true);
  h.dispose();
  assert.equal(h.observers.size, 0);
  assert.equal(h.timers.size, 0);
  await h.idle();
});

test("retained DOM callbacks are idempotent and do not schedule retry storms", async () => {
  const h = harness();
  const original = message("dom", { attachments: [photo()] });
  const row = h.addRow(original);
  const image = fakeElement();
  const link = fakeElement();
  const sourceElement = fakeElement();
  const picture = { querySelectorAll: () => [sourceElement] };
  image.src = original.attachments[0].proxy_url;
  image.srcset = "old-source";
  link.href = original.attachments[0].url;
  image.closest = (selector) => selector === "picture" ? picture : link;
  image.alt = original.attachments[0].filename;
  row.querySelectorAll = (selector) => selector === "img" ? [image] : [];
  h.rememberMessage(original);
  await h.idle();
  h.handleDispatch({ type: "MESSAGE_DELETE", id: original.id, channel_id: "100" });
  await h.idle();
  const before = [row.mutations, image.mutations, link.mutations, sourceElement.mutations, h.timers.size];
  for (let count = 0; count < 20; count++) h.captureRenderedMessage(row);
  assert.deepEqual([row.mutations, image.mutations, link.mutations, sourceElement.mutations, h.timers.size], before);
  assert.equal(h.pendingMessages.has(original.id), false);
  assert.equal(h.requests.length, 1);
});

test("a previously marked DOM element can be captured again after pending eviction", () => {
  const h = harness();
  const row = fakeElement(message("evicted"));
  h.captureRenderedMessage(row);
  for (let i = 0; i < 250; i++) h.rememberMessage(message(`new-${i}`));
  assert.equal(h.pendingMessages.has("evicted"), false);
  h.captureRenderedMessage(row);
  assert.equal(h.pendingMessages.has("evicted"), true);
});

test("clearing removes retained rows, URLs and archive blobs but preserves ordinary pending photos", async () => {
  const h = harness();
  const saved = message("clear-saved", { attachments: [photo("saved")] });
  const row = h.addRow(saved);
  h.rememberMessage(saved);
  h.rememberMessage(message("ordinary", { attachments: [photo("ordinary")] }));
  await h.idle();
  const ordinaryKey = h.pendingMessages.get("ordinary").attachments[0].blobKey;
  h.handleDispatch({ type: "MESSAGE_DELETE", id: saved.id, channel_id: "100" });
  await h.idle();
  assert.equal(h.urls.size, 1);
  await h.clearArchive();
  await h.idle();
  assert.equal(h.store.entries.length, 0);
  assert.equal(h.visibleDeletedMessages.size, 0);
  assert.equal(h.state().visibleDeletedMessageBytes, 0);
  assert.equal(h.urls.size, 0);
  assert.equal(h.blobs.size, 1);
  assert.equal(h.blobs.has(ordinaryKey), true);
  assert.equal(h.pendingMessages.has("ordinary"), true);
  assert.equal(row.classList.contains("alexandria-deleted-message"), false);
  assert.equal(h.dispatches.filter((item) => item.alexandriaRemove && item.id === saved.id).length, 1);
});

test("cancelling clear leaves the archive, retained rows and photos untouched", async () => {
  const h = harness({ confirm: async () => { throw new Error("Cancelled"); } });
  const original = message("cancel", { attachments: [photo()] });
  h.rememberMessage(original);
  h.messages.set(original.id, original);
  await h.idle();
  h.handleDispatch({ type: "MESSAGE_DELETE", id: original.id, channel_id: "100" });
  await h.idle();
  await h.clearArchive();
  assert.equal(h.store.entries.length, 1);
  assert.equal(h.visibleDeletedMessages.size, 1);
  assert.equal(h.blobs.size, 1);
  assert.equal(h.urls.size, 1);
});

test("a late download cannot restore a cleared archive or leave orphan photos", async () => {
  const download = deferred();
  const h = harness({ fetch: () => download.promise });
  const original = message("late", { attachments: [photo()] });
  h.rememberMessage(original);
  h.messages.set(original.id, original);
  h.handleDispatch({ type: "MESSAGE_DELETE", id: original.id, channel_id: "100" });
  await h.clearArchive();
  download.resolve(response());
  await h.idle();
  assert.equal(h.store.entries.length, 0);
  assert.equal(h.visibleDeletedMessages.size, 0);
  assert.equal(h.pendingMessages.size, 0);
  assert.equal(h.blobs.size, 0);
  assert.equal(h.urls.size, 0);
});

test("valid retained rows still obey the 250-message session limit", async () => {
  const h = harness();
  for (let i = 0; i <= 250; i++) {
    const original = message(`retained-${i}`);
    h.messages.set(original.id, original);
    assert.equal(h.handleDispatch({ type: "MESSAGE_DELETE", id: original.id, channel_id: "100" }), false);
  }
  await h.idle();
  assert.equal(h.visibleDeletedMessages.size, 250);
  assert.equal(h.visibleDeletedMessages.has("retained-0"), false);
  assert.equal(h.visibleDeletedMessages.has("retained-250"), true);
  assert.equal(h.store.entries.length, 251);
  assert.equal(h.dispatches.filter((item) => item.alexandriaRemove).length, 1);
});

test("retention covers other channels in the active server but not background servers", async () => {
  const h = harness();
  h.messages.set("same-server", message("same-server", { channel_id: "101" }));
  h.messages.set("background", message("background", { channel_id: "200", guild_id: "20" }));
  assert.equal(h.handleDispatch({ type: "MESSAGE_DELETE", id: "same-server", channel_id: "101" }), false);
  assert.equal(h.handleDispatch({ type: "MESSAGE_DELETE", id: "background", channel_id: "200" }), undefined);
  await h.idle();
  assert.equal(h.visibleDeletedMessages.size, 1);
  assert.equal(h.store.entries.length, 2);
});

test("DM retention stays limited to the exact active conversation", async () => {
  const h = harness();
  h.location.pathname = "/channels/@me/300";
  h.messages.set("active-dm", message("active-dm", { channel_id: "300", guild_id: "" }));
  h.messages.set("other-dm", message("other-dm", { channel_id: "301", guild_id: "" }));
  assert.equal(h.handleDispatch({ type: "MESSAGE_DELETE", id: "active-dm", channel_id: "300" }), false);
  assert.equal(h.handleDispatch({ type: "MESSAGE_DELETE", id: "other-dm", channel_id: "301" }), undefined);
  await h.idle();
  assert.equal(h.visibleDeletedMessages.size, 1);
  assert.equal(h.store.entries.length, 2);
});

test("exhausted photo fallbacks mark the attachment unavailable without saving a blob", async () => {
  const h = harness({ fetch: async () => { throw new Error("All URLs unavailable"); } });
  h.rememberMessage(message("unavailable", { attachments: [photo()] }));
  await h.idle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.blobs.size, 0);
  assert.equal(h.pendingMessages.get("unavailable").attachments[0].photoUnavailable, true);
});

test("a compaction already in progress cannot restore cleared preview URLs", async () => {
  const thumbnail = deferred();
  let thumbnailStarted = false;
  const h = harness({ thumbnail: () => { thumbnailStarted = true; return thumbnail.promise; } });
  const original = message("compacting", { attachments: [photo()] });
  h.rememberMessage(original);
  await h.idle();
  h.messages.set(original.id, original);
  h.handleDispatch({ type: "MESSAGE_DELETE", id: original.id, channel_id: "100" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thumbnailStarted, true);
  await h.clearArchive();
  thumbnail.resolve(new Blob(["thumbnail"], { type: "image/webp" }));
  await h.idle();
  assert.equal(h.urls.size, 0);
  assert.equal(h.visibleDeletedMessages.size, 0);
  assert.equal(h.dispatches.some((item) => item.alexandriaCompact), false);
});

test("a cleanup dispatch failure is reported without leaving other rows or photos retained", async () => {
  const h = harness({ dispatch: (payload) => {
    if (payload.alexandriaRemove && payload.id === "fails") throw new Error("Discord dispatch failed");
  } });
  for (const id of ["fails", "succeeds"]) {
    const original = message(id, { attachments: [photo(id)] });
    h.rememberMessage(original);
    h.messages.set(id, original);
  }
  await h.idle();
  for (const id of ["fails", "succeeds"]) h.handleDispatch({ type: "MESSAGE_DELETE", id, channel_id: "100" });
  await h.idle();
  await h.clearArchive();
  assert.equal(h.store.entries.length, 0);
  assert.equal(h.visibleDeletedMessages.size, 0);
  assert.equal(h.urls.size, 0);
  assert.equal(h.blobs.size, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0][0], /finish archive cleanup/);
});

test("unloading releases live URLs and pending blobs but preserves archived originals", async () => {
  const h = harness();
  const original = message("unload-saved", { attachments: [photo("saved")] });
  h.rememberMessage(original);
  h.rememberMessage(message("unload-pending", { attachments: [photo("pending")] }));
  h.messages.set(original.id, original);
  await h.idle();
  h.handleDispatch({ type: "MESSAGE_DELETE", id: original.id, channel_id: "100" });
  await h.idle();
  const archiveKey = h.store.entries[0].attachments[0].blobKey;
  h.onUnload();
  await h.idle();
  assert.equal(h.visibleDeletedMessages.size, 0);
  assert.equal(h.urls.size, 0);
  assert.equal(h.pendingMessages.size, 0);
  assert.equal(h.blobs.size, 1);
  assert.equal(h.blobs.has(archiveKey), true);
  assert.equal(h.rememberMessage(message("too-late")), false);
});

const experimentalStore = (extra = {}) => ({ experimentalHistoryEnabled: true, ...extra });
const channel = (id, guildId = "10", type = 0) => ({ id, guild_id: guildId, type, name: `channel-${id}` });

test("experimental capture defaults off and does not preload or retain loaded history", async () => {
  const h = harness({ channels: [channel("100")], store: { captureMode: "selected", selectedGuildIds: ["10"] } });
  h.onLoad();
  h.captureHistoryMessages([message("history-off")]);
  await h.idle();
  assert.equal(h.store.experimentalHistoryEnabled, false);
  assert.equal(h.historyMessages.size, 0);
  assert.equal(h.historyRows.size, 0);
  assert.equal(h.httpRequests.length, 0);
  assert.equal([...h.timers.values()].includes(h.preloadHistoryChannel), false);
  h.dispose();
});

test("loaded history captures an old phone deletion while the desktop is on another server", async () => {
  const h = harness({ store: experimentalStore({ captureMode: "selected", selectedGuildIds: ["10"] }) });
  h.location.pathname = "/channels/20/200";
  const old = message("old-history", { timestamp: "2020-01-01T00:00:00.000Z" });
  h.captureHistoryMessages([old]);
  await h.idle();
  assert.equal(h.pendingMessages.size, 0);
  assert.equal(h.store.entries.length, 0);
  assert.equal(h.historyRows.size, 1);
  assert.equal(h.handleDispatch({ type: "MESSAGE_DELETE", id: old.id, channel_id: "100" }), undefined);
  await h.idle();
  assert.equal(h.store.entries[0].content, old.content);
  assert.equal(h.store.entries[0].timestamp, old.timestamp);
  assert.equal(h.visibleDeletedMessages.size, 0);
  assert.equal(h.historyRows.size, 0);
});

for (const type of ["MESSAGE_DELETE", "MESSAGE_DELETE_BULK"]) {
  test(`${type} falls back to experimental history after ordinary pending eviction`, async () => {
    const h = harness({ store: experimentalStore() });
    h.rememberMessage(message("history-evicted"));
    for (let i = 0; i < 250; i++) h.rememberMessage(message(`history-new-${i}`));
    await h.idle();
    assert.equal(h.pendingMessages.has("history-evicted"), false);
    assert.equal(h.historyMessages.has("history-evicted"), true);
    const before = h.state().pendingMessageBytes;
    h.location.pathname = "/channels/20/200";
    h.handleDispatch({ type, channel_id: "100", id: "history-evicted", ids: ["history-evicted", "unknown"] });
    await h.idle();
    assert.equal(h.store.entries[0].id, "history-evicted");
    assert.equal(h.state().pendingMessageBytes, before);
    assert.equal(h.pendingMessages.size, 250);
    assert.equal(h.visibleDeletedMessages.size, 0);
    assert.equal(h.historyRows.has("history-evicted"), false);
  });
}

test("partial edits can update history-only originals without losing omitted fields", async () => {
  const h = harness({ store: experimentalStore({ logEdits: false, logDeletedAttachments: false }) });
  h.captureHistoryMessages([message("history-edit", { attachments: [photo()], embeds: [{ title: "Old" }] })]);
  const before = h.historyEntry("history-edit");
  h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: "history-edit", content: "", attachments: [], embeds: [] } });
  await h.idle();
  const after = h.historyEntry("history-edit");
  for (const key of ["authorId", "author", "username", "timestamp", "channelId", "guildId"]) assert.equal(after[key], before[key], key);
  assert.equal(after.content, "");
  assert.equal(after.attachments.length, 0);
  assert.equal(after.embeds.length, 0);
  assert.ok(h.state().pendingMessageBytes > 0);
  h.markDeleted("history-edit", "100");
  await h.idle();
  assert.equal(h.state().pendingMessageBytes, 0);
  assert.equal(h.historyRows.size, 0);
});

test("experimental history respects selected scope and global capture disable", async () => {
  const h = harness({ store: experimentalStore({ captureMode: "selected", selectedGuildIds: ["10"] }) });
  h.captureHistoryMessages([message("included"), message("excluded", { channel_id: "200", guild_id: "20" })]);
  await h.idle();
  assert.equal(h.historyMessages.has("included"), true);
  assert.equal(h.historyMessages.has("excluded"), false);
  h.store.captureEnabled = false;
  h.captureHistoryMessages([message("disabled")]);
  h.handleDispatch({ type: "MESSAGE_DELETE", id: "included", channel_id: "100" });
  assert.equal(h.store.entries.length, 0);
  assert.equal(h.historyMessages.has("disabled"), false);
});

test("history snapshots restore across plugin restarts and recover a delete during hydration", async () => {
  const first = harness({ store: experimentalStore({ captureMode: "selected", selectedGuildIds: ["10"] }) });
  first.captureHistoryMessages([message("restart-history", { timestamp: "2020-01-01T00:00:00.000Z" })]);
  await first.idle();
  first.onUnload();
  await first.idle();
  assert.equal(first.historyMessages.size, 0);
  assert.equal(first.historyRows.size, 1);
  // Simulate a client build whose ChannelStore no longer has this channel:
  // the persisted snapshot itself still supplies the selected guild ID.
  const second = harness({ disk: first.disk, store: first.store, channels: [] });
  second.location.pathname = "/channels/20/200";
  second.onLoad();
  assert.equal(second.state().historyLoaded, false);
  assert.equal(second.handleDispatch({ type: "MESSAGE_DELETE", id: "restart-history", channel_id: "100" }), undefined);
  await second.idle();
  assert.equal(second.store.entries[0].id, "restart-history");
  assert.equal(second.store.entries[0].guildId, "10");
  assert.equal(second.visibleDeletedMessages.size, 0);
  assert.equal(second.historyRows.size, 0);
  second.dispose();
});

test("ordinary captures queued just before unload are flushed to history storage", async () => {
  const h = harness({ store: experimentalStore() });
  h.rememberMessage(message("queued-history"));
  h.onUnload();
  await h.idle();
  assert.equal(h.historyRows.has("queued-history"), true);
});

test("partial edits arriving during hydration preserve the persisted original before deletion", async () => {
  const first = harness({ store: experimentalStore() });
  first.captureHistoryMessages([message("hydration-edit", { attachments: [photo()], embeds: [{ title: "Keep embed" }] })]);
  await first.idle();
  const second = harness({ disk: first.disk, store: experimentalStore() });
  second.onLoad();
  second.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: "hydration-edit", content: "New edit" } });
  second.handleDispatch({ type: "MESSAGE_DELETE", id: "hydration-edit", channel_id: "100" });
  await second.idle();
  const saved = second.store.entries[0];
  assert.equal(saved.content, "New edit");
  assert.equal(saved.authorId, "author-a");
  assert.equal(saved.timestamp, "2026-09-01T12:00:00.000Z");
  assert.equal(saved.attachments.length, 1);
  assert.equal(saved.embeds[0].title, "Keep embed");
  second.dispose();
});

for (const fields of ["timestamp", "author", "both"]) {
  test(`partial edits with ${fields} during hydration preserve omitted saved fields`, async () => {
    const first = harness({ store: experimentalStore() });
    const original = message("hydration-fields", { attachments: [photo()], embeds: [{ title: "Keep embed" }] });
    first.captureHistoryMessages([original]);
    await first.idle();
    const second = harness({ disk: first.disk, store: experimentalStore() });
    second.onLoad();
    const edit = { id: original.id, channel_id: "100", content: "Newest edit" };
    if (fields !== "author") edit.timestamp = original.timestamp;
    if (fields !== "timestamp") edit.author = original.author;
    second.handleDispatch({ type: "MESSAGE_UPDATE", message: edit });
    second.handleDispatch({ type: "MESSAGE_DELETE", id: original.id, channel_id: "100" });
    await second.idle();
    const saved = second.store.entries[0];
    assert.equal(saved.content, edit.content);
    assert.equal(saved.authorId, original.author.id);
    assert.equal(saved.attachments.length, 1);
    assert.equal(saved.embeds[0].title, "Keep embed");
    second.dispose();
  });
}

test("a deferred startup edit cannot replace a newer capture during hydration", async () => {
  const first = harness({ store: experimentalStore() });
  const original = message("hydration-order");
  first.captureHistoryMessages([original]);
  await first.idle();
  const second = harness({ disk: first.disk, store: experimentalStore() });
  second.onLoad();
  second.handleDispatch({ type: "MESSAGE_UPDATE", message: { ...original, content: "Earlier edit" } });
  second.rememberMessage({ ...original, content: "Later current snapshot" });
  await second.idle();
  assert.equal(second.pendingMessages.get(original.id).content, "Later current snapshot");
  assert.equal(second.historyEntry(original.id).content, "Later current snapshot");
  second.dispose();
});

test("multiple deferred startup edits preserve their order and omitted fields", async () => {
  const first = harness({ store: experimentalStore() });
  const original = message("hydration-multiple", { attachments: [photo()], embeds: [{ title: "Keep embed" }] });
  first.captureHistoryMessages([original]);
  await first.idle();
  const second = harness({ disk: first.disk, store: experimentalStore() });
  second.onLoad();
  second.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: original.id, attachments: [] } });
  second.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: original.id, content: "Last queued edit" } });
  second.handleDispatch({ type: "MESSAGE_DELETE", id: original.id, channel_id: "100" });
  await second.idle();
  const saved = second.store.entries[0];
  assert.equal(saved.content, "Last queued edit");
  assert.equal(saved.attachments.length, 1);
  assert.ok(saved.attachments[0].removedAt);
  assert.equal(saved.embeds[0].title, "Keep embed");
  second.dispose();
});

test("quick startup and unload still enforce the disk history cap", async () => {
  const first = harness({ store: experimentalStore() });
  first.captureHistoryMessages(Array.from({ length: 2_000 }, (_, i) => message(`disk-cap-${i}`)));
  await first.idle();
  const second = harness({ disk: first.disk, store: experimentalStore(), clock: { now: first.clock.now + 1_000 } });
  second.onLoad();
  second.rememberMessage(message("latest-disk-cap"));
  second.onUnload();
  await second.idle();
  assert.equal(second.historyRows.size, 2_000);
  assert.equal(second.historyRows.has("latest-disk-cap"), true);
  second.dispose();
});

test("restored history never overwrites a newer capture during database opening", async () => {
  const first = harness({ store: experimentalStore() });
  first.captureHistoryMessages([message("history-race", { content: "Old disk version" })]);
  await first.idle();
  const second = harness({ disk: first.disk, store: experimentalStore(), clock: { now: first.clock.now + 1_000 } });
  second.onLoad();
  second.rememberMessage(message("history-race", { content: "Fresh session version" }));
  await second.idle();
  assert.equal(second.historyEntry("history-race").content, "Fresh session version");
  assert.equal(second.historyRows.get("history-race").entry.content, "Fresh session version");
  second.dispose();
});

test("history does not retain photo blobs or evict the live photo buffer", async () => {
  const h = harness({ store: experimentalStore() });
  h.rememberMessage(message("live-photo", { attachments: [photo()] }));
  await h.idle();
  const blobKey = h.pendingMessages.get("live-photo").attachments[0].blobKey;
  h.captureHistoryMessages(Array.from({ length: 300 }, (_, i) => message(`background-photo-${i}`, { attachments: [photo(`p-${i}`)] })));
  await h.idle();
  assert.equal(h.pendingMessages.size, 1);
  assert.equal(h.blobs.has(blobKey), true);
  assert.equal(h.requests.length, 1);
  for (const record of h.historyRows.values()) {
    assert.equal(record.entry.attachments[0].blobKey, undefined);
    assert.equal(record.entry.attachments[0].cachedBytes, undefined);
  }
});

test("history is bounded to 2,000 snapshots on disk and in memory", async () => {
  const h = harness({ store: experimentalStore() });
  h.captureHistoryMessages(Array.from({ length: 2_001 }, (_, i) => message(`cap-${i}`)));
  await h.idle();
  assert.equal(h.historyMessages.size, 2_000);
  assert.equal(h.historyRows.size, 2_000);
  assert.equal(h.historyMessages.has("cap-2000"), false); // input is newest first
  assert.equal(h.historyMessages.has("cap-0"), true);
  assert.ok(h.state().historyMessageBytes <= 16 * 1024 * 1024);
});

test("history's separate 16 MB metadata budget is enforced on disk and in memory", async () => {
  const h = harness({ store: experimentalStore() });
  h.captureHistoryMessages(Array.from({ length: 100 }, (_, i) => message(`bytes-${i}`, { content: "x".repeat(100_000) })));
  await h.idle();
  assert.ok(h.historyMessages.size < 100);
  assert.equal(h.historyRows.size, h.historyMessages.size);
  assert.ok(h.state().historyMessageBytes > 0);
  assert.ok(h.state().historyMessageBytes <= 16 * 1024 * 1024);
  assert.equal(h.pendingMessages.size, 0);
});

test("snapshots expire seven days after last capture, not seven days after message creation", async () => {
  const h = harness({ store: experimentalStore() });
  h.captureHistoryMessages([message("expires", { timestamp: "2020-01-01T00:00:00.000Z" })]);
  await h.idle();
  assert.ok(h.historyEntry("expires"));
  h.clock.now += 7 * 24 * 60 * 60 * 1_000;
  assert.equal(h.historyEntry("expires"), null);
  await h.idle();
  assert.equal(h.historyRows.size, 0);
  assert.equal(h.state().historyMessageBytes, 0);
  h.handleDispatch({ type: "MESSAGE_DELETE", id: "expires", channel_id: "100" });
  assert.equal(h.store.entries.length, 0);
});

test("startup purges expired and already-archived disk snapshots", async () => {
  const first = harness({ store: experimentalStore() });
  first.captureHistoryMessages([message("expired-disk"), message("already-archived")]);
  await first.idle();
  const saved = { ...first.historyEntry("already-archived"), deleted: true, deletedAt: new Date(first.clock.now).toISOString() };
  first.historyRows.get("expired-disk").seenAt -= 8 * 24 * 60 * 60 * 1_000;
  const second = harness({ disk: first.disk, store: experimentalStore({ entries: [saved] }) });
  second.onLoad();
  await second.idle();
  assert.equal(second.historyRows.size, 0);
  assert.equal(second.historyMessages.size, 0);
  assert.equal(second.store.entries.length, 1);
  second.dispose();
});

test("disabling experimental capture purges extra history without deleting the archive or normal pending messages", async () => {
  const h = harness({ store: experimentalStore() });
  h.rememberMessage(message("normal-pending"));
  h.captureHistoryMessages([message("extra-history"), message("saved-history")]);
  h.markDeleted("saved-history", "100");
  await h.idle();
  h.setExperimentalHistoryEnabled(false);
  await h.idle();
  assert.equal(h.historyRows.size, 0);
  assert.equal(h.historyMessages.size, 0);
  assert.equal(h.state().historyMessageBytes, 0);
  assert.equal(h.store.entries[0].id, "saved-history");
  assert.equal(h.pendingMessages.has("normal-pending"), true);
});

test("passive history HTTP capture sends once, returns the unchanged response, and ignores errors", async () => {
  const h = harness({ store: experimentalStore() });
  let sends = 0;
  const result = { ok: true, body: [message("http-history", { channel_id: undefined })] };
  const returned = await h.captureHistoryResponse({ url: "/channels/100/messages?limit=50" }, async () => { sends++; return result; });
  await h.idle();
  assert.equal(returned, result);
  assert.equal(sends, 1);
  assert.equal(h.historyEntry("http-history").channelId, "100");
  await h.captureHistoryResponse({ url: "/channels/100/messages" }, async () => ({ ok: false, status: 403, body: [message("failed-history")] }));
  assert.equal(h.historyMessages.has("failed-history"), false);
});

for (const action of ["disable", "clear", "unload"]) {
  test(`late loaded-history responses cannot repopulate history after ${action}`, async () => {
    const h = harness({ store: experimentalStore() });
    const download = deferred();
    const capture = h.captureHistoryResponse({ url: "/channels/100/messages" }, () => download.promise);
    if (action === "disable") {
      h.setExperimentalHistoryEnabled(false);
      h.setExperimentalHistoryEnabled(true); // off/on must invalidate the old request too
    } else if (action === "clear") await h.clearArchive();
    else h.onUnload();
    download.resolve({ ok: true, body: [message("late-history")] });
    await capture;
    await h.idle();
    assert.equal(h.historyRows.size, 0);
    assert.equal(h.historyMessages.size, 0);
  });
}

test("history-load actions and already-loaded MessageStore collections seed the experimental cache", async () => {
  const h = harness({ store: experimentalStore() });
  h.messages.set("store-history", message("store-history"));
  h.onLoad();
  h.handleDispatch({ type: "LOAD_MESSAGES_SUCCESS", channelId: "100", messages: [message("flux-history", { channel_id: undefined })] });
  await h.idle();
  assert.equal(h.historyRows.has("store-history"), true);
  assert.equal(h.historyRows.has("flux-history"), true);
  h.dispose();
});

test("preloading fetches only selected readable text channels and DMs, not photos or read acknowledgements", async () => {
  const channels = [channel("100"), channel("101", "10", 2), channel("102"), channel("200", "20"), channel("300", "", 1), channel("301", "", 1)];
  const h = harness({
    channels, permissions: { can: (permission, candidate) => candidate.id !== "102" },
    store: experimentalStore({ captureMode: "selected", selectedGuildIds: ["10"], selectedDirectMessageIds: ["300"] }),
    httpGet: async (request) => ({ ok: true, body: [message(`preload-${request.url}`, { attachments: [photo()] })] }),
  });
  h.location.pathname = "/channels/20/200";
  h.onLoad();
  await h.runHistoryTimer();
  await h.idle();
  assert.equal(h.httpRequests.length, 1);
  assert.equal(h.httpRequests[0].url, "/channels/100/messages");
  assert.equal(h.httpRequests[0].query.limit, 100);
  assert.equal(h.httpRequests[0].retries, 0);
  assert.equal(h.historyRows.size, 1);
  assert.equal(h.requests.length, 0);
  assert.equal(h.pendingMessages.size, 0);
  assert.ok(h.timerDelays.get([...h.timers].find(([, callback]) => callback === h.preloadHistoryChannel)[0]) >= 1_000);
  await h.runHistoryTimer();
  await h.idle();
  assert.equal(h.httpRequests[1].url, "/channels/300/messages");
  assert.equal(h.historyEntry("preload-/channels/300/messages").guildId, "");
  assert.equal(h.historyRows.size, 2);
  assert.ok(h.timerDelays.get([...h.timers].find(([, callback]) => callback === h.preloadHistoryChannel)[0]) >= 300_000);
  h.dispose();
});

test("All scope does not preload the whole account, even with previously saved selections", async () => {
  const h = harness({ channels: [channel("100")], store: experimentalStore({ captureMode: "all", selectedGuildIds: ["10"] }) });
  h.onLoad();
  await h.runHistoryTimer();
  assert.equal(h.httpRequests.length, 0);
  h.captureHistoryMessages([message("all-passive")]);
  await h.idle();
  assert.equal(h.historyRows.size, 1);
  h.dispose();
});

test("preloading processes at most 20 channels per batch and rotates larger selections", async () => {
  const h = harness({ channels: Array.from({ length: 25 }, (_, i) => channel(`${1000 + i}`)), store: experimentalStore({ captureMode: "selected", selectedGuildIds: ["10"] }) });
  h.onLoad();
  for (let i = 0; i < 20; i++) await h.runHistoryTimer();
  assert.equal(h.httpRequests.length, 20);
  assert.equal(new Set(h.httpRequests.map((request) => request.url)).size, 20);
  assert.ok(h.timerDelays.get([...h.timers].find(([, callback]) => callback === h.preloadHistoryChannel)[0]) >= 300_000);
  await h.runHistoryTimer();
  assert.equal(h.httpRequests.length, 21);
  assert.equal(h.httpRequests[20].url, "/channels/1020/messages");
  h.dispose();
  await h.idle();
});

test("scope changes cannot start overlapping preloads or save a deselected in-flight response", async () => {
  const download = deferred();
  const h = harness({ channels: [channel("100"), channel("200", "20")], store: experimentalStore({ captureMode: "selected", selectedGuildIds: ["10"] }), httpGet: () => download.promise });
  h.onLoad();
  const run = h.runHistoryTimer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.httpRequests.length, 1);
  h.store.selectedGuildIds = ["20"];
  h.refreshHistoryCapture();
  await h.preloadHistoryChannel();
  assert.equal(h.httpRequests.length, 1);
  download.resolve({ ok: true, body: [message("deselected-history")] });
  await run;
  await h.idle();
  assert.equal(h.historyRows.size, 0);
  assert.equal(h.state().historyPreloadActive, false);
  h.dispose();
});

for (const throws of [false, true]) {
  test(`a ${throws ? "thrown" : "returned"} 429 pauses preloading and respects retry_after across settings changes`, async () => {
    const h = harness({ channels: [channel("100"), channel("101")], store: experimentalStore({ captureMode: "selected", selectedGuildIds: ["10"] }), httpGet: async () => {
      const limited = { ok: false, status: 429, body: { retry_after: 600 } };
      if (throws) throw limited;
      return limited;
    } });
    h.onLoad();
    await h.runHistoryTimer();
    assert.equal(h.httpRequests.length, 1);
    h.refreshHistoryCapture();
    const timer = [...h.timers].find(([, callback]) => callback === h.preloadHistoryChannel);
    assert.ok(h.timerDelays.get(timer[0]) >= 600_000);
    assert.equal(h.historyRows.size, 0);
    h.dispose();
    await h.idle();
  });
}

test("Clear archive also purges experimental history and delays the next preload", async () => {
  const h = harness({ store: experimentalStore() });
  h.captureHistoryMessages([message("clear-history")]);
  await h.idle();
  await h.clearArchive();
  await h.idle();
  assert.equal(h.historyRows.size, 0);
  assert.equal(h.historyMessages.size, 0);
  const timer = [...h.timers].find(([, callback]) => callback === h.preloadHistoryChannel);
  assert.ok(h.timerDelays.get(timer[0]) >= 300_000);
});

test("an in-flight preload cannot shorten the five-minute pause after clearing", async () => {
  const download = deferred();
  const h = harness({ channels: [channel("100")], store: experimentalStore({ captureMode: "selected", selectedGuildIds: ["10"] }), httpGet: () => download.promise });
  h.onLoad();
  const run = h.runHistoryTimer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.httpRequests.length, 1);
  await h.clearArchive();
  download.resolve({ ok: true, body: [message("late-preload-clear")] });
  await run;
  await h.idle();
  assert.equal(h.historyRows.size, 0);
  const timer = [...h.timers].find(([, callback]) => callback === h.preloadHistoryChannel);
  assert.ok(h.timerDelays.get(timer[0]) >= 300_000);
  h.dispose();
});

test("adding the separate history store does not remove existing archived photos", async () => {
  const disk = { blobs: new Map([["existing-photo", new Blob(["original"], { type: "image/png" })]]), historyRows: new Map() };
  const h = harness({ disk, store: { entries: [{ id: "existing-archive", channelId: "100", deleted: true, timestamp: "2020-01-01T00:00:00.000Z", attachments: [{ ...photo(), blobKey: "existing-photo", cachedBytes: 8 }] }] } });
  h.onLoad();
  await h.idle();
  assert.equal(h.store.entries.length, 1);
  assert.equal(await h.blobs.get("existing-photo").text(), "original");
  assert.equal(h.historyRows.size, 0);
  h.dispose();
});

for (const type of ["MESSAGE_DELETE", "MESSAGE_DELETE_BULK"]) {
  test(`${type} preserves a fresh edit while the rendered row still has old props`, async () => {
    const h = harness();
    const original = message("quick-edit-delete", { attachments: [photo()], embeds: [{ title: "Old embed" }] });
    h.addRow(original);
    h.rememberMessage(original);
    await h.idle();
    const edited = { ...original, content: "Edited before deleting", attachments: [], embeds: [] };
    h.handleDispatch({ type: "MESSAGE_UPDATE", message: edited });
    h.messages.set(original.id, edited);
    assert.equal(h.handleDispatch({ type, id: original.id, ids: [original.id], channel_id: "100" }), false);
    await h.idle();
    assert.equal(h.store.entries[0].content, edited.content);
    assert.equal(h.store.entries[0].attachments.length, 1);
    assert.ok(h.store.entries[0].attachments[0].removedAt);
    assert.equal(h.store.entries[0].embeds.length, 0);
    assert.equal(h.blobs.size, 1);
  });
}

test("DOM capture uses current store content while preserving refreshed rendered photo URLs", async () => {
  const h = harness();
  const original = message("rendered-url-refresh", { attachments: [photo()] });
  const row = h.addRow(original);
  const freshUrl = `${original.attachments[0].proxy_url}?refreshed=true`;
  row.querySelectorAll = (selector) => selector.startsWith('img[src*=') ? [{ currentSrc: freshUrl }] : [];
  h.messages.set(original.id, { ...original, content: "Current store content" });
  h.captureRenderedMessage(row);
  await h.idle();
  const captured = h.pendingMessages.get(original.id);
  assert.equal(captured.content, "Current store content");
  assert.equal(captured.attachments[0].proxyUrl, freshUrl);
  assert.equal(h.requests[0], freshUrl);
});

test("a replacement attachment with the same filename does not capture the old rendered photo", async () => {
  const h = harness();
  const original = message("replaced-photo", { attachments: [{ ...photo("old-photo"), filename: "shared.png" }] });
  const row = h.addRow(original);
  const staleUrl = original.attachments[0].proxy_url.replace("old-photo.png", "shared.png");
  row.querySelectorAll = (selector) => selector.startsWith('img[src*=') ? [{ currentSrc: staleUrl }] : [];
  const replacement = { ...photo("new-photo"), filename: "shared.png" };
  h.messages.set(original.id, { ...original, attachments: [replacement] });
  h.captureRenderedMessage(row);
  await h.idle();
  assert.equal(h.pendingMessages.get(original.id).attachments[0].proxyUrl, replacement.proxy_url);
  assert.equal(h.requests[0], replacement.proxy_url);
});

test("a stale history response cannot overwrite an edit received while its request was in flight", async () => {
  const h = harness({ store: experimentalStore() });
  const original = message("history-edit-race");
  h.rememberMessage(original);
  await h.idle();
  const download = deferred();
  const capture = h.captureHistoryResponse({ url: "/channels/100/messages" }, () => download.promise);
  h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: original.id, content: "Live edited content" } });
  download.resolve({ ok: true, body: [original] });
  await capture;
  for (let i = 0; i < 250; i++) h.rememberMessage(message(`edit-race-new-${i}`));
  await h.idle();
  assert.equal(h.pendingMessages.has(original.id), false);
  h.location.pathname = "/channels/20/200";
  h.handleDispatch({ type: "MESSAGE_DELETE", id: original.id, channel_id: "100" });
  await h.idle();
  assert.equal(h.store.entries[0].content, "Live edited content");
});

test("a stale preload cannot overwrite a newer live edit", async () => {
  const download = deferred();
  const h = harness({ channels: [channel("100")], store: experimentalStore({ captureMode: "selected", selectedGuildIds: ["10"] }), httpGet: () => download.promise });
  h.onLoad();
  const original = message("preload-edit-race");
  h.rememberMessage(original);
  const run = h.runHistoryTimer();
  await new Promise((resolve) => setImmediate(resolve));
  h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: original.id, content: "Newest content" } });
  download.resolve({ ok: true, body: [original] });
  await run;
  await h.idle();
  assert.equal(h.store.entries.find((entry) => entry.id === original.id).content, "Newest content");
  assert.equal(h.historyRows.has(original.id), false);
  h.dispose();
});

for (const copied of [false, true]) {
  test(`a stale history load action preserves a live edit with ${copied ? "a copied array" : "the response body"}`, async () => {
    const h = harness({ store: experimentalStore() });
    const original = message("flux-history-edit-race");
    h.rememberMessage(original);
    await h.idle();
    const download = deferred();
    const capture = h.captureHistoryResponse({ url: "/channels/100/messages" }, () => download.promise);
    h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: original.id, content: "Newest live edit" } });
    download.resolve({ ok: true, body: [original] });
    const result = await capture;
    h.handleDispatch({ type: "LOAD_MESSAGES_SUCCESS", channelId: "100", messages: copied ? result.body.slice() : result.body });
    for (let i = 0; i < 250; i++) h.rememberMessage(message(`flux-race-new-${i}`));
    await h.idle();
    assert.equal(h.pendingMessages.has(original.id), false);
    h.handleDispatch({ type: "MESSAGE_DELETE", id: original.id, channel_id: "100" });
    assert.equal(h.store.entries[0].content, "Newest live edit");
    await h.idle();
  });
}

for (const action of ["clear", "disable", "scope change"]) {
  for (const copied of [false, true]) {
    test(`a late history load action cannot repopulate history after ${action} using ${copied ? "copied messages" : "the response body"}`, async () => {
      const h = harness({ store: experimentalStore() });
      const download = deferred();
      const capture = h.captureHistoryResponse({ url: "/channels/100/messages" }, () => download.promise);
      if (action === "clear") await h.clearArchive();
      else if (action === "disable") {
        h.setExperimentalHistoryEnabled(false);
        h.setExperimentalHistoryEnabled(true);
      } else {
        h.store.captureMode = "selected";
        h.store.selectedGuildIds = ["20"];
        h.refreshHistoryCapture();
        h.store.captureMode = "all";
        h.refreshHistoryCapture();
      }
      download.resolve({ ok: true, body: [message("late-flux-history")] });
      const result = await capture;
      h.handleDispatch({ type: "LOAD_MESSAGES_SUCCESS", channelId: "100", messages: copied ? result.body.slice() : result.body });
      await h.idle();
      assert.equal(h.historyMessages.size, 0);
      assert.equal(h.historyRows.size, 0);
      h.dispose();
    });
  }
}

test("unattributed history loads seed unseen messages without replacing live edits", async () => {
  const h = harness({ store: experimentalStore() });
  h.rememberMessage(message("unattributed-live", { content: "Live edit" }));
  h.handleDispatch({ type: "LOAD_MESSAGES_SUCCESS", channelId: "100", messages: [message("unattributed-live"), message("unattributed-unseen")] });
  await h.idle();
  assert.equal(h.historyEntry("unattributed-live").content, "Live edit");
  assert.equal(h.historyEntry("unattributed-unseen").content, "Original content");
});

test("unattributed history loads can refresh restored disk snapshots", async () => {
  const first = harness({ store: experimentalStore() });
  first.captureHistoryMessages([message("unattributed-disk")]);
  await first.idle();
  const second = harness({ disk: first.disk, store: experimentalStore() });
  second.onLoad();
  await second.idle();
  second.handleDispatch({ type: "LOAD_MESSAGES_SUCCESS", channelId: "100", messages: [message("unattributed-disk", { content: "New loaded content" })] });
  await second.idle();
  assert.equal(second.historyEntry("unattributed-disk").content, "New loaded content");
  second.dispose();
});

test("a failed history response cannot be recaptured through a load action", async () => {
  const h = harness({ store: experimentalStore() });
  const result = await h.captureHistoryResponse({ url: "/channels/100/messages" }, async () => ({ ok: false, status: 403, body: [message("failed-flux-history")] }));
  h.handleDispatch({ type: "LOAD_MESSAGES_SUCCESS", channelId: "100", messages: result.body.slice() });
  await h.idle();
  assert.equal(h.historyRows.size, 0);
});

test("a failed unload dispatch does not prevent remaining row and pending photo cleanup", async () => {
  const h = harness({ dispatch: (payload) => {
    if (payload.alexandriaRemove && payload.id === "unload-fails") throw new Error("Discord dispatch failed");
  } });
  for (const id of ["unload-fails", "unload-succeeds"]) {
    const original = message(id, { attachments: [photo(id)] });
    h.rememberMessage(original);
    h.messages.set(id, original);
  }
  h.rememberMessage(message("unload-staged", { attachments: [photo("staged")] }));
  await h.idle();
  for (const id of ["unload-fails", "unload-succeeds"]) {
    h.handleDispatch({ type: "MESSAGE_DELETE", id, channel_id: "100" });
  }
  await h.idle();
  const archiveKeys = h.store.entries.flatMap((entry) => entry.attachments.map((attachment) => attachment.blobKey));
  assert.equal(h.urls.size, 2);
  assert.equal(h.blobs.size, 3);

  assert.doesNotThrow(() => h.onUnload());
  assert.equal(h.errors.length, 1);
  const [reportedError] = h.errors.splice(0);
  assert.match(reportedError[0], /retained message during unload/);
  await h.idle();
  assert.equal(h.visibleDeletedMessages.size, 0);
  assert.equal(h.state().visibleDeletedMessageBytes, 0);
  assert.equal(h.urls.size, 0);
  assert.equal(h.pendingMessages.size, 0);
  assert.equal(h.blobs.size, 2);
  for (const key of archiveKeys) assert.equal(h.blobs.has(key), true);
  assert.equal(h.dispatches.filter((item) => item.alexandriaRemove).length, 2);
});

for (const cleanup of ["clear", "unload"]) {
  test(`${cleanup} removes retained Discord rows using Flux channelId actions`, async () => {
    const h = harness();
    for (const channelId of ["100", "101"]) {
      const original = message(`flux-cleanup-${channelId}`, { channel_id: channelId });
      h.messages.set(original.id, original);
      h.addRow(original);
      assert.equal(h.handleDispatch({ type: "MESSAGE_DELETE", id: original.id, channelId }), false);
    }
    await h.idle();
    assert.equal(h.messages.size, 2);
    assert.equal(h.rows.size, 2);

    if (cleanup === "clear") await h.clearArchive();
    else h.onUnload();
    await h.idle();

    assert.equal(h.messages.size, 0);
    assert.equal(h.rows.size, 0);
    assert.equal(h.visibleDeletedMessages.size, 0);
    assert.deepEqual(h.dispatches.filter((action) => action.alexandriaRemove).map((action) => action.channelId), ["100", "101"]);
  });
}

test("retention eviction removes the oldest Discord row from its channel", async () => {
  const h = harness();
  for (let index = 0; index <= 250; index++) {
    const original = message(`flux-eviction-${index}`, { channel_id: index === 0 ? "101" : "100" });
    h.messages.set(original.id, original);
    if (index === 0) h.addRow(original);
    assert.equal(h.handleDispatch({ type: "MESSAGE_DELETE", id: original.id, channelId: original.channel_id }), false);
  }
  await h.idle();
  assert.equal(h.messages.has("flux-eviction-0"), false);
  assert.equal(h.rows.size, 0);
  assert.equal(h.messages.size, 250);
  assert.equal(h.dispatches.find((action) => action.alexandriaRemove).channelId, "101");
  assert.equal(h.store.entries.length, 251);
});

for (const flags of [64, 68, "64", 64n]) {
  test(`ephemeral flags ${String(flags)} are excluded from live and history capture`, async () => {
    const h = harness({ store: experimentalStore() });
    const ephemeral = message("ephemeral", { flags, attachments: [photo()] });
    h.handleDispatch({ type: "MESSAGE_CREATE", message: ephemeral });
    h.captureRenderedMessage(fakeElement({ ...ephemeral, channel_id: undefined, channelId: "100" }));
    h.captureHistoryMessages([ephemeral]);
    h.messages.set(ephemeral.id, ephemeral);
    h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: ephemeral.id, channel_id: "100", content: "Partial ephemeral edit" } });
    assert.equal(h.handleDispatch({ type: "MESSAGE_DELETE", id: ephemeral.id, channelId: "100" }), undefined);
    await h.idle();
    assert.equal(h.pendingMessages.size, 0);
    assert.equal(h.historyMessages.size, 0);
    assert.equal(h.historyRows.size, 0);
    assert.equal(h.store.entries.length, 0);
    assert.equal(h.visibleDeletedMessages.size, 0);
    assert.equal(h.requests.length, 0);
  });
}

test("mixed bulk deletes retain ordinary messages while ephemeral responses delete normally", async () => {
  const h = harness();
  const ephemeral = message("bulk-ephemeral", { flags: 64 });
  const ordinary = message("bulk-ordinary", { flags: 4 });
  for (const original of [ephemeral, ordinary]) h.messages.set(original.id, original);
  const result = h.handleDispatch({ type: "MESSAGE_DELETE_BULK", channelId: "100", ids: [ephemeral.id, ordinary.id] });
  await h.idle();
  assert.deepEqual(Array.from(result.ids), [ephemeral.id]);
  assert.equal(h.store.entries.length, 1);
  assert.equal(h.store.entries[0].id, ordinary.id);
  assert.equal(h.visibleDeletedMessages.has(ephemeral.id), false);
  assert.equal(h.visibleDeletedMessages.has(ordinary.id), true);
});

test("stalled photo jobs are pruned and aborted when their pending messages are evicted", async () => {
  const signals = [];
  const h = harness({ fetch: (url, init) => {
    signals.push(init.signal);
    return new Promise(() => {});
  } });
  for (let index = 0; index < 2_000; index++) {
    h.rememberMessage(message(`stalled-queue-${index}`, { attachments: [photo(`queue-${index}`)] }));
  }
  assert.equal(h.pendingMessages.size, 250);
  assert.equal(h.state().activePhotoCaptures, 3);
  assert.ok(h.state().queued <= 250);
  assert.equal(signals.length, 3);
  assert.ok(signals.every((signal) => signal.aborted));
  h.onUnload();
  await h.idle();
  assert.equal(h.state().activePhotoCaptures, 0);
  assert.equal(h.state().queued, 0);
  assert.equal(h.blobs.size, 0);
});

test("the photo queue has a hard cap even when every queued attachment is archived", async () => {
  const signals = [];
  const h = harness({ fetch: (url, init) => {
    signals.push(init.signal);
    return new Promise(() => {});
  } });
  h.store.entries = Array.from({ length: 24 }, (_, entryIndex) => ({
    id: `archive-queue-${entryIndex}`, channelId: "100", guildId: "10", content: "Archived",
    timestamp: "2026-09-01T12:00:00.000Z", deleted: true,
    attachments: Array.from({ length: 24 }, (_, photoIndex) => ({
      ...photo(`archive-queue-${entryIndex}-${photoIndex}`), isImage: true, contentType: "image/png",
    })),
  }));
  h.store.entries.forEach((entry) => h.cachePhotos(entry.id, entry.attachments));
  assert.equal(h.state().activePhotoCaptures, 3);
  assert.equal(h.state().queued, 512);
  assert.equal(signals.length, 3);
  assert.ok(signals.every((signal) => !signal.aborted));
  h.onUnload();
  await h.idle();
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(h.state().activePhotoCaptures, 0);
  assert.equal(h.state().queued, 0);
});

test("pending eviction preserves an in-flight attachment that has moved into the archive", async () => {
  const signals = [];
  const h = harness({ fetch: (url, init) => {
    signals.push(init.signal);
    return new Promise(() => {});
  } });
  for (let index = 0; index < 3; index++) {
    h.rememberMessage(message(`archive-inflight-${index}`, { attachments: [photo(`archive-inflight-${index}`)] }));
  }
  h.markDeleted("archive-inflight-0", "100");
  for (let index = 0; index < 300; index++) h.rememberMessage(message(`evict-after-archive-${index}`));
  assert.equal(h.store.entries[0].id, "archive-inflight-0");
  assert.equal(signals[0].aborted, false);
  assert.equal(signals[1].aborted, true);
  assert.equal(signals[2].aborted, true);
  h.onUnload();
  await h.idle();
  assert.ok(signals.every((signal) => signal.aborted));
});

for (const phase of ["headers", "body"]) {
  test(`the photo deadline cancels a stalled ${phase} read and rejects late results`, async () => {
    const stalled = deferred();
    let signal;
    let reading = false;
    let released = false;
    const h = harness({ fetch: (url, init) => {
      signal = init.signal;
      if (phase === "headers") return stalled.promise;
      return { ...response(), body: { getReader: () => ({
        read: () => { reading = true; return stalled.promise; },
        releaseLock: () => { released = true; },
      }) } };
    } });
    h.rememberMessage(message(`stalled-${phase}`, { attachments: [photo(`stalled-${phase}`)] }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reading, phase === "body");
    assert.equal(signal.aborted, false);
    const deadlines = [...h.timers].filter(([id]) => h.timerDelays.get(id) === 20_000);
    assert.equal(deadlines.length, 1);
    const [id, expire] = deadlines[0];
    h.timers.delete(id);
    h.timerDelays.delete(id);
    expire();
    await h.idle();
    assert.equal(signal.aborted, true);
    assert.equal(h.state().activePhotoCaptures, 0);
    assert.equal(h.pendingMessages.get(`stalled-${phase}`).attachments[0].photoUnavailable, true);
    assert.equal(h.blobs.size, 0);
    stalled.resolve(phase === "headers" ? response() : { done: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.blobs.size, 0);
    if (phase === "body") assert.equal(released, true);
  });
}

test("expired photo captures free all three slots for the next queued attachment", async () => {
  const signals = [];
  const h = harness({ fetch: (url, init) => {
    signals.push(init.signal);
    return url.includes("after-timeout") ? response() : new Promise(() => {});
  } });
  for (let index = 0; index < 3; index++) {
    h.rememberMessage(message(`deadline-${index}`, { attachments: [photo(`deadline-${index}`)] }));
  }
  h.rememberMessage(message("after-timeout", { attachments: [photo("after-timeout")] }));
  assert.equal(h.state().queued, 1);
  const deadlines = [...h.timers].filter(([id]) => h.timerDelays.get(id) === 20_000);
  assert.equal(deadlines.length, 3);
  for (const [id, expire] of deadlines) {
    h.timers.delete(id);
    h.timerDelays.delete(id);
    expire();
  }
  await h.idle();
  assert.equal(h.requests.length, 4);
  assert.equal(h.blobs.size, 1);
  assert.ok(h.pendingMessages.get("after-timeout").attachments[0].blobKey);
  assert.ok(signals.slice(0, 3).every((signal) => signal.aborted));
  assert.equal(h.state().activePhotoCaptures, 0);
  assert.equal(h.state().queued, 0);
  assert.equal([...h.timers].filter(([id]) => h.timerDelays.get(id) === 20_000).length, 0);
});

test("edit logging defaults on while ordinary messages remain session-only", () => {
  const h = harness();
  assert.equal(h.store.logEdits, true);
  assert.equal(h.store.logDeletedAttachments, true);
  h.rememberMessage(message("ordinary"));
  assert.equal(h.store.entries.length, 0);
});

test("text edits persist previous versions, including empty content, without losing omitted fields", async () => {
  const h = harness();
  const original = message("revisions");
  h.rememberMessage(original);
  const editedAt = "2026-09-01T12:01:00.000Z";
  h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: original.id, content: "", edited_timestamp: editedAt } });
  h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: original.id, content: "Final version" } });
  await h.idle();
  const saved = h.store.entries[0];
  assert.equal(saved.content, "Final version");
  assert.equal(saved.authorId, original.author.id);
  assert.equal(saved.timestamp, original.timestamp);
  assert.equal(saved.channelId, original.channel_id);
  assert.deepEqual(Array.from(saved.editHistory, (revision) => revision.content), [original.content, ""]);
  assert.equal(saved.editHistory[0].editedAt, editedAt);
  assert.equal(saved.deleted, undefined);
  assert.equal(h.pendingMessages.has(original.id), false);
  h.markDeleted(original.id, original.channel_id);
  assert.equal(h.store.entries[0].deleted, true);
  assert.equal(h.store.entries[0].editHistory.length, 2);
});

test("the first observed edit recovers its original from Discord's loaded store", async () => {
  const h = harness();
  const original = message("store-original");
  h.messages.set(original.id, original);
  h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: original.id, channel_id: "100", content: "Updated" } });
  await h.idle();
  assert.equal(h.store.entries[0].editHistory[0].content, original.content);
  assert.equal(h.store.entries[0].content, "Updated");
});

test("duplicate updates, embeds and refreshed URLs do not create text revisions", async () => {
  const h = harness();
  const original = message("metadata-updates", { attachments: [photo()] });
  h.rememberMessage(original);
  h.handleDispatch({ type: "MESSAGE_UPDATE", message: original });
  h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: original.id, embeds: [{ title: "Preview" }] } });
  h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: original.id, attachments: [{ ...photo(), proxy_url: "https://refreshed.example/photo.png" }] } });
  await h.idle();
  assert.equal(h.store.entries.length, 0);
  assert.equal(h.pendingMessages.get(original.id).editHistory.length, 0);
});

test("edit history retains the latest 25 versions and obeys its text byte budget", async () => {
  const h = harness();
  h.rememberMessage(message("bounded-edits", { content: "version 0" }));
  for (let i = 1; i <= 40; i++) h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: "bounded-edits", content: `version ${i}` } });
  assert.equal(h.store.entries[0].editHistory.length, 25);
  assert.equal(h.store.entries[0].editHistory[0].content, "version 15");
  assert.equal(h.store.entries[0].editHistory.at(-1).content, "version 39");
  for (let i = 0; i < 8; i++) h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: "bounded-edits", content: String(i).repeat(32_000) } });
  const bytes = h.store.entries[0].editHistory.reduce((sum, revision) => sum + (revision.content.length + revision.editedAt.length) * 2 + 32, 0);
  assert.ok(bytes <= 128 * 1024);
  assert.equal(h.store.entries[0].content[0], "7");
  await h.idle();
});

test("attachments removed by edits retain their photo blobs across recapture and restart", async () => {
  const h = harness();
  const original = message("removed-photo", { attachments: [photo()] });
  h.rememberMessage(original);
  await h.idle();
  const key = h.pendingMessages.get(original.id).attachments[0].blobKey;
  h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: original.id, attachments: [] } });
  h.rememberMessage({ ...original, attachments: [] });
  await h.idle();
  assert.ok(h.store.entries[0].attachments[0].removedAt);
  assert.equal(h.store.entries[0].attachments[0].blobKey, key);
  assert.ok(h.blobs.has(key));
  const second = harness({ disk: h.disk, store: structuredClone(h.store) });
  second.onLoad();
  await second.idle();
  assert.ok(second.blobs.has(key));
  assert.equal(second.store.entries[0].attachments[0].blobKey, key);
  second.dispose();
});

test("removed attachment history retains the newest 50 attachments", async () => {
  const h = harness();
  const files = (batch) => Array.from({ length: 10 }, (_, i) => ({ id: `${batch}-${i}`, filename: `${batch}-${i}.txt`, url: `https://files.example/${batch}-${i}` }));
  h.rememberMessage(message("attachment-limit", { attachments: files(0) }));
  for (let batch = 1; batch <= 7; batch++) h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: "attachment-limit", attachments: files(batch) } });
  const saved = h.store.entries[0];
  const removed = saved.attachments.filter((attachment) => attachment.removedAt);
  assert.equal(removed.length, 50);
  assert.ok(removed.some((attachment) => attachment.id === "6-9"));
  assert.ok(!removed.some((attachment) => attachment.id.startsWith("0-") || attachment.id.startsWith("1-")));
  assert.equal(saved.attachments.filter((attachment) => !attachment.removedAt).length, 10);
  await h.idle();
});

test("a removed photo whose download finishes after the edit attaches to its archived history", async () => {
  const download = deferred();
  const h = harness({ fetch: () => download.promise });
  const original = message("removed-in-flight", { attachments: [photo()] });
  h.rememberMessage(original);
  h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: original.id, attachments: [] } });
  download.resolve(response());
  await h.idle();
  const attachment = h.store.entries[0].attachments[0];
  assert.ok(attachment.removedAt);
  assert.ok(h.blobs.has(attachment.blobKey));
});

test("archived edits obey the separate 16 MB metadata cap", async () => {
  const h = harness();
  for (let i = 0; i < 20; i++) {
    const id = `metadata-cap-${i}`;
    h.rememberMessage(message(id));
    h.handleDispatch({ type: "MESSAGE_UPDATE", message: { id, content: "x".repeat(600_000) } });
  }
  assert.ok(h.store.entries.length < 20);
  assert.ok(h.store.entries.reduce((bytes, entry) => bytes + entry.content.length * 2, 0) <= 16 * 1024 * 1024);
  await h.idle();
});

test("a deferred startup edit cannot overwrite a newer edit already promoted to the archive", async () => {
  const first = harness({ store: experimentalStore() });
  const original = message("hydration-archive-race");
  first.captureHistoryMessages([original]);
  await first.idle();
  const second = harness({ disk: first.disk, store: experimentalStore() });
  second.onLoad();
  second.handleDispatch({ type: "MESSAGE_UPDATE", message: { id: original.id, content: "Older deferred edit" } });
  second.messages.set(original.id, original);
  second.handleDispatch({ type: "MESSAGE_UPDATE", message: { ...original, content: "Newest live edit" } });
  await second.idle();
  assert.equal(second.store.entries[0].content, "Newest live edit");
  assert.equal(second.store.entries[0].editHistory.length, 1);
  second.dispose();
});
