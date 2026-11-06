import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../plugins/alexandria/index.jsx", import.meta.url), "utf8");
const lookup = source.slice(source.indexOf("function photoCaptureAttachment("), source.indexOf("function prepareMediaDatabase("));
const queue = source.slice(source.indexOf("function queuePhotoCaptures("), source.indexOf("function mergeArchiveEntry("));

function harness(archive = []) {
  const started = [];
  const jobs = new Map();
  const context = vm.createContext({
    archive,
    started,
    jobs,
    AbortController,
  });
  vm.runInContext(`
    let pluginUnloading = false;
    let archiveClearing = false;
    const MAX_PHOTO_CAPTURE_QUEUE = 512;
    const pendingMessages = new Map();
    const photoCapturesInFlight = new Set();
    const queuedPhotoCaptures = new Set();
    const photoCaptureControllers = new Map();
    const photoCaptureQueue = [];
    let activePhotoCaptures = 0;
    const entries = () => archive;
    const attachmentKey = (attachment) => attachment.id;
    function cachePhoto(messageId, attachment) {
      const key = attachmentKey(attachment);
      const captureKey = messageId + ":" + key;
      const controller = new AbortController();
      photoCapturesInFlight.add(captureKey);
      photoCaptureControllers.set(captureKey, { controller, messageId, key });
      started.push(captureKey);
      return new Promise((resolve) => {
        jobs.set(captureKey, { controller, finish: resolve });
        controller.signal.addEventListener("abort", resolve, { once: true });
      }).finally(() => {
        photoCapturesInFlight.delete(captureKey);
        photoCaptureControllers.delete(captureKey);
      });
    }
    ${lookup}
    ${queue}
    globalThis.api = {
      cachePhotos, backfillArchivedPhotos, drainPhotoCaptureQueue, pendingMessages,
      state: () => ({ active: activePhotoCaptures, queued: photoCaptureQueue.length }),
      queued: () => photoCaptureQueue.map((job) => job.captureKey),
      setClearing: (value) => { archiveClearing = value; },
    };
  `, context);
  return { ...context.api, archive, started, jobs };
}

const attachment = (id) => ({ id, isImage: true });
const entry = (id, count = 1) => ({
  id,
  attachments: Array.from({ length: count }, (_, index) => attachment(`${id}-photo-${index}`)),
});

test("ordinary text captures and an idle queue do not scan the archive", () => {
  const h = harness([{
    get id() { assert.fail("Idle photo handling should not inspect archive IDs"); },
    attachments: [],
  }]);
  h.cachePhotos("text-only", []);
  h.cachePhotos("already-cached", [{ ...attachment("cached"), blobKey: "saved" }]);
  h.drainPhotoCaptureQueue();
  assert.equal(h.state().active, 0);
  assert.equal(h.state().queued, 0);
});

test("backfilling the full archive avoids repeated archive scans and preserves queue limits", () => {
  let idReads = 0;
  const archive = Array.from({ length: 2_000 }, (_, index) => ({
    get id() { idReads++; return `archived-${index}`; },
    attachments: [attachment(`photo-${index}`)],
  }));
  const h = harness(archive);
  h.backfillArchivedPhotos();

  assert.ok(idReads < 20_000, `Backfill repeatedly scanned archive IDs (${idReads} reads)`);
  assert.equal(h.state().active, 3);
  assert.equal(h.state().queued, 512);
  assert.equal(h.started.length, 3);
  assert.equal(new Set(h.queued()).size, 512);
});

test("draining cancels evicted pending work and keeps a queued photo promoted into the archive", async () => {
  const h = harness();
  for (let index = 0; index < 4; index++) {
    const pending = entry(`pending-${index}`);
    h.pendingMessages.set(pending.id, pending);
    h.cachePhotos(pending.id, pending.attachments);
  }
  const promoted = h.pendingMessages.get("pending-3");
  h.archive.push(promoted);
  h.pendingMessages.clear();
  h.drainPhotoCaptureQueue();
  assert.ok([...h.jobs.values()].every((job) => job.controller.signal.aborted));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state().active, 1);
  assert.equal(h.state().queued, 0);
  assert.equal(h.started.at(-1), "pending-3:pending-3-photo-0");
});

test("a full temporary queue still admits archived photo repairs", () => {
  const h = harness();
  const pending = entry("pending", 515);
  h.pendingMessages.set(pending.id, pending);
  h.cachePhotos(pending.id, pending.attachments);
  h.cachePhotos(pending.id, pending.attachments);
  assert.equal(h.state().queued, 512);

  const archived = entry("archived");
  h.archive.push(archived);
  h.cachePhotos(archived.id, archived.attachments);
  assert.equal(h.state().active, 3);
  assert.equal(h.state().queued, 512);
  assert.ok(h.queued().includes("archived:archived-photo-0"));
});

test("archive clearing prevents batch backfill from adding work", () => {
  const h = harness([entry("archived")]);
  h.setClearing(true);
  h.backfillArchivedPhotos();
  assert.equal(h.state().active, 0);
  assert.equal(h.state().queued, 0);
});
