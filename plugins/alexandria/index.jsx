import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import styles from "./styles.css";

const {
  plugin: { store, scoped },
  ui: {
    Button,
    ButtonColors,
    ButtonSizes,
    ModalBody,
    ModalFooter,
    ModalHeader,
    ModalRoot,
    ModalSizes,
    ReactiveRoot,
    Select,
    SelectOption,
    SwitchItem,
    TextBox,
    openConfirmationModal,
    openModal,
  },
  util: { getFiber, getProps, reactFiberWalker },
} = shelter;

const ARCHIVE_KEY = "entries";
const ARCHIVE_SCHEMA_VERSION = 2;
const MEDIA_DATABASE_NAME = "alexandria-media";
const MEDIA_DATABASE_VERSION = 1;
const MEDIA_STORE_NAME = "photos";
const launcherId = "alexandria-launcher-host";
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
// Keeping every message in a busy server makes the persisted store and its
// reactive updates grow without bound. This is intentionally a rolling local
// archive; deleted entries are retained just like ordinary captured entries.
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PENDING_MESSAGES = 250;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_PHOTO_BYTES = 300 * 1024 * 1024;
const MAX_VISIBLE_DELETED_MESSAGES = 250;
const MAX_VISIBLE_DELETED_BYTES = 300 * 1024 * 1024;
const MAX_LIVE_IMAGE_EDGE = 512;
const MAX_ARCHIVE_IMAGE_EDGE = 2_048;
const MIN_LIVE_MESSAGE_BYTES = 64 * 1024;
const ARCHIVE_PAGE_SIZE = 100;

store[ARCHIVE_KEY] ??= [];
// Version 0.8 intentionally starts a fresh archive. Earlier releases embedded
// base64 photos directly in the reactive store; retaining those would defeat
// the new disk-backed memory model.
if (store.archiveSchemaVersion !== ARCHIVE_SCHEMA_VERSION) {
  store[ARCHIVE_KEY] = [];
  store.archiveSchemaVersion = ARCHIVE_SCHEMA_VERSION;
}
store.captureEnabled ??= true;
store.captureMode ??= "all";
store.selectedGuildIds ??= [];
store.selectedDirectMessageIds ??= [];
store.activeMode ??= store.captureMode === "active";
if (store.captureMode === "active") {
  store.captureMode =
    (Array.isArray(store.selectedGuildIds) && store.selectedGuildIds.length) ||
    (Array.isArray(store.selectedDirectMessageIds) && store.selectedDirectMessageIds.length)
      ? "selected"
      : "all";
}
store.showButton ??= true;
store.sortMode ??= "deletedAt";
store.serverFilter ??= "";
store.userFilter ??= "";
store.directMessageFilter ??= "";
store.photoBackfillEnabled ??= false;
store.launcherPosition ??= null;

let launcherHost;
let removeModal;
let removePhotoModal;
let stopLauncherDrag;
let suppressLauncherClick = false;
const photoCapturesInFlight = new Set();
const photoRepairsInFlight = new Set();
const queuedPhotoCaptures = new Set();
const photoCaptureQueue = [];
let activePhotoCaptures = 0;
let archiveTrimTimer;
let mediaDatabasePromise;
let mediaReadyPromise;
let pluginUnloading = false;
let livePreviewWork = Promise.resolve();
const pendingMessages = new Map();
let pendingMessageBytes = 0;
let pendingPhotoBytes = 0;
const visibleDeletedMessages = new Map();
let visibleDeletedMessageBytes = 0;

const entries = () => (Array.isArray(store[ARCHIVE_KEY]) ? store[ARCHIVE_KEY] : []);
const fluxStores = shelter.flux?.storesFlat || {};
const fluxDispatcher = shelter.flux?.dispatcher;

function mediaDatabase() {
  mediaDatabasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(MEDIA_DATABASE_NAME, MEDIA_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MEDIA_STORE_NAME)) {
        database.createObjectStore(MEDIA_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Alexandria media database is blocked."));
  });
  return mediaDatabasePromise;
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("Media transaction aborted."));
    transaction.onerror = () => reject(transaction.error || new Error("Media transaction failed."));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readPhotoBlob(blobKey) {
  if (!blobKey) return null;
  const database = await mediaDatabase();
  const transaction = database.transaction(MEDIA_STORE_NAME, "readonly");
  return requestResult(transaction.objectStore(MEDIA_STORE_NAME).get(blobKey));
}

async function writePhotoBlob(blobKey, blob) {
  await prepareMediaDatabase();
  const database = await mediaDatabase();
  const transaction = database.transaction(MEDIA_STORE_NAME, "readwrite");
  transaction.objectStore(MEDIA_STORE_NAME).put(blob, blobKey);
  await transactionComplete(transaction);
}

async function deletePhotoBlobs(blobKeys) {
  const keys = [...new Set(blobKeys.filter(Boolean))];
  if (!keys.length) return;
  const database = await mediaDatabase();
  const transaction = database.transaction(MEDIA_STORE_NAME, "readwrite");
  const photos = transaction.objectStore(MEDIA_STORE_NAME);
  keys.forEach((key) => photos.delete(key));
  await transactionComplete(transaction);
}

function entryPhotoKeys(entry) {
  return (entry?.attachments || []).map((attachment) => attachment.blobKey).filter(Boolean);
}

function prepareMediaDatabase() {
  mediaReadyPromise ??= (async () => {
    const database = await mediaDatabase();
    const transaction = database.transaction(MEDIA_STORE_NAME, "readonly");
    const keys = await requestResult(transaction.objectStore(MEDIA_STORE_NAME).getAllKeys());
    const retainedKeys = new Set(entries().flatMap(entryPhotoKeys));
    await deletePhotoBlobs(keys.filter((key) => !retainedKeys.has(key)));
  })();
  return mediaReadyPromise;
}

function asString(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value);
}

function archiveActivityTime(entry) {
  return Date.parse(entry.deletedAt || entry.timestamp) || 0;
}

function archiveEntryBytes(entry) {
  // Photo blobs live in IndexedDB, so count their recorded byte sizes without
  // loading them into memory or serializing them into Shelter's store.
  const textBytes = (value) => asString(value).length * 2;
  let size = [
    entry.id,
    entry.channelId,
    entry.guildId,
    entry.guildName,
    entry.directMessageName,
    entry.channelName,
    entry.authorId,
    entry.author,
    entry.username,
    entry.content,
    entry.timestamp,
    entry.deletedAt,
  ].reduce((total, value) => total + textBytes(value), 128);

  for (const embed of entry.embeds || []) {
    size += textBytes(embed.title) + textBytes(embed.description) + textBytes(embed.url);
  }
  for (const attachment of entry.attachments || []) {
    size += textBytes(attachment.id) + textBytes(attachment.filename) + textBytes(attachment.url);
    size += textBytes(attachment.proxyUrl) + textBytes(attachment.contentType);
    size += Math.max(0, Number(attachment.cachedBytes) || 0);
  }
  return size;
}

function pendingEntryBytes(entry) {
  return Math.max(
    0,
    archiveEntryBytes(entry) -
      (entry?.attachments || []).reduce(
        (total, attachment) => total + Math.max(0, Number(attachment.cachedBytes) || 0),
        0,
      ),
  );
}

function pendingEntryPhotoBytes(entry) {
  return (entry?.attachments || []).reduce(
    (total, attachment) => total + Math.max(0, Number(attachment.cachedBytes) || 0),
    0,
  );
}

function discardPendingEntry(entry) {
  if (!entry) return;
  pendingMessageBytes = Math.max(0, pendingMessageBytes - pendingEntryBytes(entry));
  pendingPhotoBytes = Math.max(0, pendingPhotoBytes - pendingEntryPhotoBytes(entry));
  void deletePhotoBlobs(entryPhotoKeys(entry)).catch((error) => {
    console.error("[Alexandria] Could not remove pre-delete photo blobs", error);
  });
}

function trimPendingPhotoCache() {
  if (pendingPhotoBytes <= MAX_PENDING_PHOTO_BYTES) return;

  for (const [messageId, entry] of pendingMessages) {
    if (pendingPhotoBytes <= MAX_PENDING_PHOTO_BYTES) break;
    const photoKeys = entryPhotoKeys(entry);
    if (!photoKeys.length) continue;
    const removedBytes = pendingEntryPhotoBytes(entry);
    const attachments = entry.attachments.map((attachment) => {
      if (!attachment.blobKey) return attachment;
      const { blobKey, cachedBytes, ...metadata } = attachment;
      return metadata;
    });
    pendingMessages.set(messageId, { ...entry, attachments });
    pendingPhotoBytes = Math.max(0, pendingPhotoBytes - removedBytes);
    void deletePhotoBlobs(photoKeys).catch((error) => {
      console.error("[Alexandria] Could not trim pre-delete photo blobs", error);
    });
  }
}

function liveMessageBytes(message) {
  const entry = toArchiveEntry(message);
  let size = entry ? archiveEntryBytes(entry) : MIN_LIVE_MESSAGE_BYTES;

  // Retained Discord rows can keep both the encoded attachment and its
  // decoded image surface alive. Count both when metadata is available so a
  // handful of high-resolution images cannot defeat the session memory cap.
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  for (const attachment of attachments) {
    const encodedBytes = Math.max(0, Number(attachment?.size) || 0);
    const width = Math.max(0, Number(attachment?.width) || 0);
    const height = Math.max(0, Number(attachment?.height) || 0);
    const decodedBytes = Math.min(Number.MAX_SAFE_INTEGER, width * height * 4);
    size += encodedBytes + decodedBytes;
  }

  for (const embed of Array.isArray(message?.embeds) ? message.embeds : []) {
    for (const media of [embed?.image, embed?.thumbnail]) {
      if (!media) continue;
      const { width, height } = compactMediaDimensions(media.width, media.height);
      size += width * height * 4;
    }
  }

  return Math.max(MIN_LIVE_MESSAGE_BYTES, size);
}

function compactMediaDimensions(widthValue, heightValue) {
  const width = Math.max(0, Number(widthValue) || 0);
  const height = Math.max(0, Number(heightValue) || 0);
  if (!width || !height) return { width: MAX_LIVE_IMAGE_EDGE, height: MAX_LIVE_IMAGE_EDGE };

  const scale = Math.min(1, MAX_LIVE_IMAGE_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function liveThumbnailBlob(blob, widthValue, heightValue) {
  const dimensions = compactMediaDimensions(widthValue, heightValue);
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  image.src = objectUrl;

  try {
    await image.decode();
    const naturalDimensions = compactMediaDimensions(image.naturalWidth, image.naturalHeight);
    const width = Math.min(dimensions.width, naturalDimensions.width);
    const height = Math.min(dimensions.height, naturalDimensions.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (preview) => (preview ? resolve(preview) : reject(new Error("Could not create live preview."))),
        "image/webp",
        0.82,
      );
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function applyCompactedRetainedMessage(messageId, channelId, message) {
  const preview = visibleDeletedMessages.get(messageId);
  if (!preview || pluginUnloading) return;

  const archived = entries().find((entry) => entry.id === messageId);
  const archivedAttachments = archived?.attachments || [];
  const sourceAttachments = Array.isArray(message?.attachments) ? message.attachments : archivedAttachments;
  const imageAttachments = archivedAttachments.filter((attachment) => attachment.isImage);

  // Until every image has been captured, leave Discord's exact pre-delete
  // URL untouched. Rewriting an older signed URL after deletion can invalidate
  // it even though the already-rendered pre-delete URL still works.
  if (imageAttachments.some((attachment) => !attachment.blobKey)) return;

  const objectUrls = [];
  try {
    const attachments = [];
    for (const archivedAttachment of archivedAttachments) {
      const source = sourceAttachments.find(
        (attachment) => attachmentKey(attachment) === attachmentKey(archivedAttachment),
      ) || archivedAttachment;
      if (!archivedAttachment.isImage) {
        attachments.push({ ...source, waveform: undefined });
        continue;
      }

      const blob = await readPhotoBlob(archivedAttachment.blobKey);
      if (!(blob instanceof Blob)) return;
      const thumbnail = await liveThumbnailBlob(blob, archivedAttachment.width, archivedAttachment.height);
      const objectUrl = URL.createObjectURL(thumbnail);
      objectUrls.push(objectUrl);
      const dimensions = compactMediaDimensions(archivedAttachment.width, archivedAttachment.height);
      attachments.push({
        ...source,
        id: archivedAttachment.id,
        filename: archivedAttachment.filename,
        url: objectUrl,
        proxy_url: objectUrl,
        proxyUrl: objectUrl,
        proxyURL: objectUrl,
        download_url: objectUrl,
        downloadUrl: objectUrl,
        originalUrl: archivedAttachment.url,
        content_type: thumbnail.type,
        contentType: thumbnail.type,
        size: thumbnail.size,
        width: dimensions.width,
        height: dimensions.height,
        waveform: undefined,
      });
    }

    const compacted = {
      id: messageId,
      channel_id: channelId,
      content: asString(message?.content || archived?.content),
      attachments,
      embeds: (Array.isArray(message?.embeds) ? message.embeds : []).map((embed) => ({
        ...embed,
        video: undefined,
      })),
      sticker_items: [],
      stickers: [],
      components: [],
    };

    const currentPreview = visibleDeletedMessages.get(messageId);
    if (!currentPreview || pluginUnloading) return;
    (currentPreview.objectUrls || []).forEach((url) => URL.revokeObjectURL(url));
    visibleDeletedMessageBytes = Math.max(0, visibleDeletedMessageBytes - currentPreview.bytes);
    currentPreview.objectUrls = objectUrls.splice(0);
    currentPreview.bytes = liveMessageBytes(compacted);
    visibleDeletedMessageBytes += currentPreview.bytes;

    while (
      visibleDeletedMessages.size > MAX_VISIBLE_DELETED_MESSAGES ||
      visibleDeletedMessageBytes > MAX_VISIBLE_DELETED_BYTES
    ) {
      const [oldestId, oldest] = visibleDeletedMessages.entries().next().value;
      releaseDeletedMessage(oldestId, oldest.channelId);
    }
    if (!visibleDeletedMessages.has(messageId)) return;

    fluxDispatcher?.dispatch?.({
      type: "MESSAGE_UPDATE",
      message: compacted,
      alexandriaCompact: true,
    });
    markDeletedMessageAfterRender(messageId, channelId);
  } catch (error) {
    console.error("[Alexandria] Could not create a bounded live photo preview", error);
  } finally {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
  }
}

function compactRetainedMessage(messageId, channelId, message) {
  const retainedMessage = message || messageFromStore(messageId, channelId) || entries().find((entry) => entry.id === messageId);
  livePreviewWork = livePreviewWork
    .then(() => applyCompactedRetainedMessage(messageId, channelId, retainedMessage))
    .catch((error) => console.error("[Alexandria] Live preview queue failed", error));
  return retainedMessage;
}

function trimArchive(next) {
  // Preserve the most recently active messages, rather than relying on the
  // array order which can differ for migrated archives and message updates.
  const mostRecent = next
    .slice()
    .sort((left, right) => archiveActivityTime(right) - archiveActivityTime(left));
  let bytes = 0;
  const retained = [];

  for (const entry of mostRecent) {
    const entryBytes = archiveEntryBytes(entry);
    if (retained.length >= MAX_ARCHIVE_ENTRIES || bytes + entryBytes > MAX_ARCHIVE_BYTES) continue;
    retained.push(entry);
    bytes += entryBytes;
  }

  if (retained.length === next.length) return next;

  const retainedIds = new Set(retained.map((entry) => entry.id));
  const removedPhotoKeys = next
    .filter((entry) => !retainedIds.has(entry.id))
    .flatMap(entryPhotoKeys);
  void deletePhotoBlobs(removedPhotoKeys).catch((error) => {
    console.error("[Alexandria] Could not remove trimmed photo blobs", error);
  });
  return retained;
}

function scheduleArchiveTrim() {
  clearTimeout(archiveTrimTimer);
  archiveTrimTimer = setTimeout(() => {
    const current = entries();
    const trimmed = trimArchive(current);
    if (trimmed !== current) store[ARCHIVE_KEY] = trimmed;
  }, 250);
}

function releaseDeletedMessage(messageId, channelId) {
  const preview = visibleDeletedMessages.get(messageId);
  if (preview) {
    visibleDeletedMessageBytes = Math.max(0, visibleDeletedMessageBytes - preview.bytes);
    (preview.objectUrls || []).forEach((url) => URL.revokeObjectURL(url));
  }
  visibleDeletedMessages.delete(messageId);
  fluxDispatcher?.dispatch?.({
    type: "MESSAGE_DELETE",
    id: messageId,
    channel_id: channelId,
    alexandriaRemove: true,
  });
}

function retainDeletedMessagePreview(messageId, channelId, message) {
  if (!messageId || !channelId) return;
  const previous = visibleDeletedMessages.get(messageId);
  if (previous) {
    visibleDeletedMessageBytes = Math.max(0, visibleDeletedMessageBytes - previous.bytes);
    (previous.objectUrls || []).forEach((url) => URL.revokeObjectURL(url));
  }
  const retainedMessage = message || entries().find((entry) => entry.id === messageId);

  const preview = {
    channelId,
    bytes: liveMessageBytes(retainedMessage),
    objectUrls: [],
  };
  visibleDeletedMessages.delete(messageId);
  visibleDeletedMessages.set(messageId, preview);
  visibleDeletedMessageBytes += preview.bytes;

  while (
    visibleDeletedMessages.size > MAX_VISIBLE_DELETED_MESSAGES ||
    visibleDeletedMessageBytes > MAX_VISIBLE_DELETED_BYTES
  ) {
    const [oldestId, oldest] = visibleDeletedMessages.entries().next().value;
    releaseDeletedMessage(oldestId, oldest.channelId);
  }

  markDeletedMessageAfterRender(messageId, channelId);
}

// Apply the retention limit on load as well, so an existing large archive is
// released at the next plugin start instead of only limiting future messages.
const initialEntries = entries();
const trimmedInitialEntries = trimArchive(initialEntries);
if (trimmedInitialEntries !== initialEntries) store[ARCHIVE_KEY] = trimmedInitialEntries;

async function photoBlobForClipboard(blob) {
  // Chromium reliably accepts PNG clipboard images, so convert unsupported
  // stored formats before the second clipboard attempt.
  if (blob.type === "image/png") return blob;

  const image = new Image();
  const objectUrl = URL.createObjectURL(blob);
  image.src = objectUrl;
  try {
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d").drawImage(image, 0, 0);

    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (png) => (png ? resolve(png) : reject(new Error("Could not prepare the photo for copying."))),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function copyPhoto(blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image copying is not available in this Discord client.");
  }

  try {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  } catch {
    const png = await photoBlobForClipboard(blob);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  }
}

function imageTypeFromFilename(filename) {
  const extension = filename.split(".").pop()?.toLowerCase();
  return {
    avif: "image/avif",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  }[extension] || "";
}

function normaliseAttachment(attachment) {
  const filename = asString(attachment?.filename || attachment?.name, "Attachment");
  const contentType = asString(attachment?.content_type || attachment?.contentType);
  const url = asString(attachment?.url || attachment?.download_url || attachment?.downloadUrl);
  const proxyUrl = asString(
    attachment?.proxy_url || attachment?.proxyUrl || attachment?.proxyURL || attachment?.preview_url,
  );

  return {
    id: asString(attachment?.id),
    filename,
    url,
    proxyUrl,
    contentType,
    size: Math.max(0, Number(attachment?.size) || 0),
    width: Math.max(0, Number(attachment?.width) || 0),
    height: Math.max(0, Number(attachment?.height) || 0),
    isImage: contentType.startsWith("image/") || Boolean(imageTypeFromFilename(filename)),
  };
}

function attachmentKey(attachment) {
  return attachment.id || attachment.url || attachment.proxyUrl;
}

function normaliseEmbed(embed) {
  return {
    title: asString(embed?.title),
    description: asString(embed?.description),
    url: asString(embed?.url),
  };
}

function userDisplayName(user) {
  return asString(user?.global_name || user?.display_name || user?.username || user?.name);
}

function directMessageName(channel) {
  if (!channel) return "";

  const recipients = Array.isArray(channel.recipients) ? channel.recipients : [];
  const names = recipients
    .map((recipient) => {
      if (typeof recipient === "object") return userDisplayName(recipient);
      return userDisplayName(fluxStores.UserStore?.getUser?.(asString(recipient)));
    })
    .filter(Boolean);

  return names.join(", ") || asString(channel.name);
}

function channelName(channel) {
  return asString(channel?.name || channel?.topic);
}

function storedIdList(key) {
  return Array.isArray(store[key]) ? store[key].map(asString).filter(Boolean) : [];
}

function messageLocation(message, fallbackChannelId = "") {
  const channelId = asString(message?.channel_id || message?.channelId || fallbackChannelId);
  const channel = fluxStores.ChannelStore?.getChannel?.(channelId);
  const guildId = asString(
    message?.guild_id || message?.guildId || message?.guild?.id || channel?.guild_id || channel?.guildId,
  );

  return { channelId, guildId };
}

function selectedChannelId() {
  const selectedChannelStore = fluxStores.SelectedChannelStore;
  const routeChannelId = globalThis.location?.pathname?.match?.(/\/channels\/(?:@me|\d+)\/(\d+)/)?.[1];
  return asString(
    routeChannelId ||
      selectedChannelStore?.getChannelId?.() ||
      selectedChannelStore?.getCurrentlySelectedChannelId?.() ||
      "",
  );
}

function shouldCaptureMessage(message, fallbackChannelId = "") {
  // Capture disabled is always authoritative. Active can add the current
  // server/DM to the saved scope, but never bypasses this global switch.
  if (store.captureEnabled === false) return false;

  const { channelId, guildId } = messageLocation(message, fallbackChannelId);
  if (!channelId) return false;

  if (store.activeMode === true) {
    const activeChannelId = selectedChannelId();
    if (activeChannelId) {
      const route = globalThis.location?.pathname?.match?.(/\/channels\/(@me|\d+)\/(\d+)/);
      if (route?.[1] && route[1] !== "@me" && guildId === route[1]) return true;
      if (route?.[1] === "@me" && channelId === route[2]) return true;

      const activeChannel = fluxStores.ChannelStore?.getChannel?.(activeChannelId);
      const activeGuildId = asString(activeChannel?.guild_id || activeChannel?.guildId);
      // Active is additive: it admits the current server/DM, then the normal
      // All/Selected scope below continues to admit its configured sources.
      if (activeGuildId ? guildId === activeGuildId : channelId === activeChannelId) return true;
    }
  }

  const mode = asString(store.captureMode, "all");
  if (mode === "all") return true;

  if (mode === "selected") {
    return guildId
      ? storedIdList("selectedGuildIds").includes(guildId)
      : storedIdList("selectedDirectMessageIds").includes(channelId);
  }

  return true;
}

function toArchiveEntry(message) {
  if (!message || !message.id) return null;

  const author = message.author || {};
  const channelId = asString(message.channel_id || message.channelId);
  const channel = fluxStores.ChannelStore?.getChannel?.(channelId);
  // Delete and store-recovery payloads do not always include guild_id. A
  // guild channel carries the same information, while DM channels do not.
  const guildId = asString(
    message.guild_id || message.guildId || message.guild?.id || channel?.guild_id || channel?.guildId,
  );
  const guild = fluxStores.GuildStore?.getGuild?.(guildId);
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.map(normaliseAttachment)
    : [];
  const embeds = Array.isArray(message.embeds) ? message.embeds.map(normaliseEmbed) : [];
  const content = asString(message.content);

  if (!content && attachments.length === 0 && embeds.length === 0 && !author.username) return null;

  return {
    id: asString(message.id),
    channelId,
    guildId,
    guildName: asString(
      message.guild?.name || message.guild_name || message.guildName || guild?.name || channel?.guild?.name,
    ),
    directMessageName: guildId ? "" : directMessageName(channel),
    channelName: channelName(channel),
    authorId: asString(author.id || message.author_id || message.authorId),
    author: asString(author.global_name || author.display_name || author.username, "Unknown user"),
    username: asString(author.username),
    content,
    attachments,
    embeds,
    timestamp: asString(message.timestamp, new Date().toISOString()),
  };
}

function sameJSON(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeAttachments(incoming, previous = []) {
  return incoming.map((attachment) => {
    const captured = previous.find((item) => attachmentKey(item) === attachmentKey(attachment));
    return captured?.blobKey
      ? {
          ...attachment,
          blobKey: captured.blobKey,
          cachedBytes: captured.cachedBytes,
          photoUnavailable: captured.photoUnavailable,
        }
      : attachment;
  });
}

async function readBoundedResponseBlob(response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength && contentLength > MAX_PHOTO_BYTES) {
    await response.body?.cancel?.();
    return null;
  }

  if (!response.body?.getReader) {
    const blob = await response.blob();
    return blob.size <= MAX_PHOTO_BYTES ? blob : null;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PHOTO_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new Blob(chunks, { type: response.headers.get("content-type") || "" });
}

function discordMediaFallbackUrls(attachment) {
  const source = asString(attachment?.proxyUrl || attachment?.url);
  if (!source) return [];

  try {
    const url = new URL(source);
    if (!/^(?:cdn|media)\.discordapp\.(?:com|net)$/.test(url.hostname)) return [];
    if (!url.pathname.includes("/attachments/")) return [];
    url.hostname = "media.discordapp.net";
    const naturalWidth = Math.max(1, Number(attachment?.width) || 4);
    const naturalHeight = Math.max(1, Number(attachment?.height) || 3);
    const candidateWidths = [
      Math.min(naturalWidth, 1_280),
      Math.min(naturalWidth, 960),
      Math.min(naturalWidth, 640),
      Math.min(naturalWidth, MAX_ARCHIVE_IMAGE_EDGE),
    ];
    return [...new Set(candidateWidths)]
      .filter((width) => width > 0)
      .map((width) => {
        const candidate = new URL(url);
        candidate.searchParams.set("format", "webp");
        candidate.searchParams.set("width", String(Math.round(width)));
        candidate.searchParams.set(
          "height",
          String(Math.max(1, Math.round((width * naturalHeight) / naturalWidth))),
        );
        return candidate.toString();
      });
  } catch {
    return [];
  }
}

function setPhotoCaptureStatus(messageId, key, photoUnavailable) {
  const current = entries();
  const entryIndex = current.findIndex((entry) => entry.id === messageId);
  if (entryIndex === -1) {
    const pending = pendingMessages.get(messageId);
    if (!pending) return;
    const attachments = pending.attachments.map((item) =>
      attachmentKey(item) === key ? { ...item, photoUnavailable } : item,
    );
    pendingMessages.set(messageId, { ...pending, attachments });
    return;
  }

  const attachments = current[entryIndex].attachments.map((item) =>
    attachmentKey(item) === key ? { ...item, photoUnavailable } : item,
  );
  if (sameJSON(attachments, current[entryIndex].attachments)) return;

  const next = [...current];
  next[entryIndex] = { ...next[entryIndex], attachments };
  store[ARCHIVE_KEY] = next;
  scheduleArchiveTrim();
}

async function cachePhoto(messageId, attachment) {
  const photoSourceUrls = (candidate) => [
    candidate?.proxyUrl,
    ...discordMediaFallbackUrls(candidate),
    candidate?.url,
  ].filter(Boolean);
  const sourceUrls = [...new Set(photoSourceUrls(attachment))];
  if (!attachment.isImage || sourceUrls.length === 0) return;

  const key = attachmentKey(attachment);
  const captureKey = `${messageId}:${key}`;
  if (photoCapturesInFlight.has(captureKey)) return;
  photoCapturesInFlight.add(captureKey);

  try {
    let blob;

    for (let sourceIndex = 0; sourceIndex < sourceUrls.length; sourceIndex += 1) {
      const latestEntry = pendingMessages.get(messageId) || entries().find((entry) => entry.id === messageId);
      const latestAttachment = latestEntry?.attachments?.find(
        (item) => attachmentKey(item) === attachmentKey(attachment),
      );
      photoSourceUrls(latestAttachment).forEach((url) => {
        if (!sourceUrls.includes(url)) sourceUrls.push(url);
      });
      const sourceUrl = sourceUrls[sourceIndex];
      const response = await fetch(sourceUrl);
      if (!response.ok) continue;

      const candidate = await readBoundedResponseBlob(response);
      if (!candidate) continue;

      // Discord may serve an image as application/octet-stream. The attachment
      // metadata is still authoritative, so retain it with that image type.
      const imageType = candidate.type.startsWith("image/")
        ? candidate.type
        : attachment.contentType.startsWith("image/")
          ? attachment.contentType
          : imageTypeFromFilename(attachment.filename);
      if (!imageType) continue;

      blob = new Blob([candidate], { type: imageType });
      break;
    }

    if (!blob) {
      setPhotoCaptureStatus(messageId, key, true);
      return;
    }

    if (pluginUnloading) return;
    let current = entries();
    let entryIndex = current.findIndex((entry) => entry.id === messageId);
    if (entryIndex === -1 && !pendingMessages.has(messageId)) return;

    const blobKey = captureKey;
    await writePhotoBlob(blobKey, blob);
    current = entries();
    entryIndex = current.findIndex((entry) => entry.id === messageId);
    const pending = pendingMessages.get(messageId);
    if (pluginUnloading || (entryIndex === -1 && !pending)) {
      await deletePhotoBlobs([blobKey]);
      return;
    }

    if (entryIndex === -1) {
      const attachments = pending.attachments.map((item) =>
        attachmentKey(item) === key && !item.blobKey
          ? { ...item, blobKey, cachedBytes: blob.size, photoUnavailable: false }
          : item,
      );
      if (sameJSON(attachments, pending.attachments)) {
        await deletePhotoBlobs([blobKey]);
        return;
      }
      const remembered = { ...pending, attachments };
      pendingMessageBytes -= pendingEntryBytes(pending);
      pendingPhotoBytes -= pendingEntryPhotoBytes(pending);
      pendingMessages.set(messageId, remembered);
      pendingMessageBytes += pendingEntryBytes(remembered);
      pendingPhotoBytes += pendingEntryPhotoBytes(remembered);
      trimPendingPhotoCache();
      return;
    }

    const attachments = current[entryIndex].attachments.map((item) =>
      attachmentKey(item) === key && !item.blobKey
        ? { ...item, blobKey, cachedBytes: blob.size, photoUnavailable: false }
        : item,
    );
    if (sameJSON(attachments, current[entryIndex].attachments)) {
      await deletePhotoBlobs([blobKey]);
      return;
    }

    const next = [...current];
    next[entryIndex] = { ...next[entryIndex], attachments };
    // Enforce the persistent cap before assigning into the reactive store so
    // an oversized intermediate archive is never handed to persistence.
    store[ARCHIVE_KEY] = trimArchive(next);
    if (visibleDeletedMessages.has(messageId)) {
      compactRetainedMessage(
        messageId,
        current[entryIndex].channelId,
        messageFromStore(messageId, current[entryIndex].channelId),
      );
    }
  } catch {
    // A CDN request can fail after a message is deleted. Keep a visible status
    // instead of presenting the expiring remote link as archived content.
    setPhotoCaptureStatus(messageId, key, true);
  } finally {
    photoCapturesInFlight.delete(captureKey);
  }
}

function cachePhotos(messageId, attachments) {
  attachments.forEach((attachment) => {
    if (!attachment.isImage || attachment.blobKey) return;

    const captureKey = `${messageId}:${attachmentKey(attachment)}`;
    if (photoCapturesInFlight.has(captureKey) || queuedPhotoCaptures.has(captureKey)) return;

    queuedPhotoCaptures.add(captureKey);
    photoCaptureQueue.push({ messageId, attachment, captureKey });
  });

  drainPhotoCaptureQueue();
}

function drainPhotoCaptureQueue() {
  while (activePhotoCaptures < 3 && photoCaptureQueue.length) {
    const { messageId, attachment, captureKey } = photoCaptureQueue.shift();
    queuedPhotoCaptures.delete(captureKey);
    if (!pendingMessages.has(messageId) && !entries().some((entry) => entry.id === messageId)) continue;
    activePhotoCaptures += 1;

    void cachePhoto(messageId, attachment).finally(() => {
      activePhotoCaptures -= 1;
      drainPhotoCaptureQueue();
    });
  }
}

function backfillArchivedPhotos() {
  entries().forEach((entry) => cachePhotos(entry.id, entry.attachments || []));
}

function mergeArchiveEntry(previous, incoming) {
  return {
    ...previous,
    ...incoming,
    // MESSAGE_UPDATE payloads are often partial. Preserve richer data already captured.
    content: incoming.content || previous.content,
    attachments: incoming.attachments.length
      ? mergeAttachments(incoming.attachments, previous.attachments)
      : previous.attachments,
    embeds: incoming.embeds.length ? incoming.embeds : previous.embeds,
    guildName: incoming.guildName || previous.guildName || "",
    directMessageName: incoming.directMessageName || previous.directMessageName || "",
    channelName: incoming.channelName || previous.channelName || "",
  };
}

function rememberMessage(message) {
  if (!shouldCaptureMessage(message)) return false;

  const incoming = toArchiveEntry(message);
  if (!incoming) return false;

  const previous = pendingMessages.get(incoming.id);
  const remembered = previous ? mergeArchiveEntry(previous, incoming) : incoming;
  if (previous) {
    pendingMessageBytes -= pendingEntryBytes(previous);
    pendingPhotoBytes -= pendingEntryPhotoBytes(previous);
  }
  // Map insertion order makes eviction inexpensive and bounds live memory.
  pendingMessages.delete(incoming.id);
  pendingMessages.set(incoming.id, remembered);
  pendingMessageBytes += pendingEntryBytes(remembered);
  pendingPhotoBytes += pendingEntryPhotoBytes(remembered);
  while (pendingMessages.size > MAX_PENDING_MESSAGES || pendingMessageBytes > MAX_PENDING_BYTES) {
    const [oldestId, oldest] = pendingMessages.entries().next().value;
    pendingMessages.delete(oldestId);
    discardPendingEntry(oldest);
  }
  cachePhotos(remembered.id, remembered.attachments);
  return true;
}

function messageFromStore(id, channelId) {
  const messageStore = fluxStores.MessageStore;
  if (!messageStore || !id) return null;

  try {
    // A delete action is intercepted before Discord removes the message from
    // its store. This also covers messages that existed before Alexandria
    // started, provided they are still loaded in the current channel.
    const direct = channelId && messageStore.getMessage?.(channelId, id);
    if (direct?.id) return direct;

    const collection = channelId && messageStore.getMessages?.(channelId);
    const fromCollection = collection?.get?.(id) || collection?._array?.find?.((message) => message.id === id);
    if (fromCollection?.id) return fromCollection;
  } catch {
    // Discord's message-store implementation changes occasionally. The
    // normal captured-message path remains available if this lookup fails.
  }

  return null;
}

function messageFromRenderedDom(id, channelId) {
  const messageId = asString(id);
  const currentChannelId = asString(channelId);
  const candidates = [
    currentChannelId && document.getElementById(`chat-messages-${currentChannelId}-${messageId}`),
    document.getElementById(`message-content-${messageId}`),
    document.getElementById(`message-username-${messageId}`),
  ].filter(Boolean);

  for (const element of candidates) {
    const message = messageFromRenderedElement(element);
    if (message?.id === messageId) return messageWithRenderedAttachmentUrls(message, element);
  }

  return null;
}

function messageWithRenderedAttachmentUrls(message, element) {
  if (!message || !Array.isArray(message.attachments) || !message.attachments.length) return message;
  const row = element?.closest?.('[data-list-item-id], li') || element;
  const renderedUrls = [
    ...(row?.querySelectorAll?.('img[src*="/attachments/"], video[src*="/attachments/"]') || []),
  ]
    .map((media) => asString(media.currentSrc || media.src))
    .filter(Boolean);
  if (!renderedUrls.length) return message;

  const attachments = message.attachments.map((attachment) => {
    const id = asString(attachment?.id);
    const filename = asString(attachment?.filename || attachment?.name);
    const renderedUrl = renderedUrls.find((url) => {
      let decodedUrl = url;
      try {
        decodedUrl = decodeURIComponent(url);
      } catch {
        // Keep matching against the encoded URL if decoding fails.
      }
      return (id && url.includes(`/${id}/`)) || (filename && decodedUrl.includes(`/${filename}`));
    });
    return renderedUrl
      ? { ...attachment, proxy_url: renderedUrl, proxyUrl: renderedUrl, proxyURL: renderedUrl }
      : attachment;
  });
  return { ...message, attachments };
}

function markDeleted(id, channelId) {
  if (!id) return false;

  const messageId = asString(id);
  let current = entries();
  let index = current.findIndex((entry) => entry.id === messageId);
  let pending = pendingMessages.get(messageId);

  // Messages sent before plugin startup do not have a MESSAGE_CREATE event for
  // Alexandria to observe. Recover them from Discord's store while the delete
  // action is still in flight, then archive them like any other message.
  if (index === -1) {
    const message =
      messageFromRenderedDom(messageId, asString(channelId)) ||
      messageFromStore(messageId, asString(channelId));
    if (message) {
      rememberMessage({ ...message, channel_id: message.channel_id || channelId });
      pending = pendingMessages.get(messageId);
    }
  }

  if (index === -1 && !pending) return false;
  if (index !== -1 && current[index].deleted) return true;

  const previous = index === -1 ? null : current[index];
  const archived = previous
    ? { ...mergeArchiveEntry(previous, pending || previous), deleted: true, deletedAt: new Date().toISOString() }
    : { ...pending, deleted: true, deletedAt: new Date().toISOString() };
  const candidate = index === -1 ? [...current, archived] : current.map((entry, entryIndex) => (entryIndex === index ? archived : entry));
  const next = trimArchive(candidate);
  store[ARCHIVE_KEY] = next;
  if (pending) {
    pendingMessageBytes = Math.max(0, pendingMessageBytes - pendingEntryBytes(pending));
    pendingPhotoBytes = Math.max(0, pendingPhotoBytes - pendingEntryPhotoBytes(pending));
  }
  pendingMessages.delete(messageId);
  if (next.some((entry) => entry.id === messageId)) cachePhotos(messageId, archived.attachments);
  scheduleArchiveTrim();

  markDeletedMessageAfterRender(messageId, asString(channelId));
  return true;
}

function messageFromPayload(payload) {
  const candidates = [
    payload?.message,
    payload?.data?.message,
    payload?.payload?.message,
    payload?.data,
    payload,
  ];

  return candidates.find((candidate) => candidate && typeof candidate === "object" && candidate.id);
}

function handleDispatch(payload) {
  if (!payload?.type) return;
  if (store.captureEnabled === false) return;

  if (payload.type === "CHANNEL_SELECT" || payload.type === "GUILD_SELECT") {
    // Let Discord update its selected-channel store and render the new view,
    // then index already-loaded messages when Active mode is in use.
    if (store.activeMode === true) setTimeout(captureLoadedMessages, 0);
    return;
  }

  // Allow Alexandria's explicit cleanup action through to Discord's store.
  // Without this marker, the normal delete interceptor would retain it again.
  if (
    (payload.alexandriaRemove &&
      (payload.type === "MESSAGE_DELETE" || payload.type === "MESSAGE_DELETE_BULK")) ||
    (payload.alexandriaCompact && payload.type === "MESSAGE_UPDATE")
  ) return;

  if (payload.type === "MESSAGE_CREATE" || payload.type === "MESSAGE_UPDATE") {
    rememberMessage(messageFromPayload(payload));
    return;
  }

  if (payload.type === "MESSAGE_DELETE") {
    const messageId = payload.id || payload.messageId || payload.message?.id;
    const channelId =
      payload.channel_id || payload.channelId || payload.message?.channel_id || payload.message?.channelId;
    const snapshot =
      messageFromRenderedDom(asString(messageId), asString(channelId)) ||
      messageFromStore(asString(messageId), asString(channelId)) ||
      payload.message;
    // A message remembered while it was visible remains eligible even if the
    // delete payload no longer contains enough channel metadata to re-check
    // the selected-scope setting.
    if (!shouldCaptureMessage(snapshot, channelId) && !pendingMessages.has(asString(messageId))) return;

    try {
      markDeleted(messageId, channelId);
    } catch {
      // Archive enrichment is best-effort and must never affect Discord's
      // normal delete processing.
    }
    // Keep the red in-chat treatment until the plugin unloads or the bounded
    // session-retention queue evicts this row.
    const compacted = compactRetainedMessage(asString(messageId), asString(channelId), snapshot);
    retainDeletedMessagePreview(asString(messageId), asString(channelId), compacted);
    return false;
  }

  if (payload.type === "MESSAGE_DELETE_BULK") {
    const ids = payload.ids || payload.messageIds || payload.messages;
    const channelId = payload.channel_id || payload.channelId;
    if (!shouldCaptureMessage(null, channelId)) return;
    if (Array.isArray(ids)) {
      ids.forEach((id) => {
        const messageId = asString(id?.id || id);
        const messageChannelId = asString(id?.channel_id || id?.channelId || channelId);
        const snapshot =
          messageFromRenderedDom(messageId, messageChannelId) ||
          messageFromStore(messageId, messageChannelId) ||
          id?.message;
        try {
          markDeleted(messageId, messageChannelId);
        } catch {
          // Keep each retained row independent from archive enrichment.
        }
        const compacted = compactRetainedMessage(messageId, messageChannelId, snapshot);
        retainDeletedMessagePreview(messageId, messageChannelId, compacted);
      });
    }
    // Deleted rows last for the session, but count and estimated encoded plus
    // decoded image memory caps keep bulk deletes from growing without bound.
    return false;
  }
}

function messageFromRenderedElement(element) {
  if (!element) return null;
  try {
    const directProps = getProps(element);
    const directMessage =
      directProps?.message ||
      directProps?.children?.props?.message ||
      directProps?.data?.message;

    if (directMessage?.id) return directMessage;

    const fiber = reactFiberWalker(getFiber(element), "message", true);
    const message =
      fiber?.message ||
      fiber?.pendingProps?.message ||
      fiber?.memoizedProps?.message ||
      fiber?.stateNode?.props?.message;

    // Do not mark the element until its fiber has yielded a message. React can
    // briefly render the element before the message props are attached.
    return message?.id ? message : null;
  } catch {
    // Discord's internal fiber shape can change between client updates.
    return null;
  }
}

function markRenderedMessageDeleted(messageId, channelId) {
  if (!messageId) return;

  // Discord's rendered rows use this ID. Unlike a fiber lookup, it remains
  // reliable after the delete dispatch has been intercepted.
  const rows = new Set();
  const directRow = channelId && document.getElementById(`chat-messages-${channelId}-${messageId}`);
  if (directRow) rows.add(directRow);

  const content = document.getElementById(`message-content-${messageId}`);
  const username = document.getElementById(`message-username-${messageId}`);
  [content, username].filter(Boolean).forEach((element) => {
    rows.add(element.closest('[data-list-item-id], li') || element);
  });

  document
    .querySelectorAll(`[data-list-item-id*="${messageId}"], [id*="${messageId}"]`)
    .forEach((element) => rows.add(element.closest('[data-list-item-id], li') || element));

  rows.forEach((row) => {
    row.classList.add("alexandria-deleted-message");
    row.dataset.alexandriaDeleted = "true";
    // Older Alexandria versions injected a badge into the message DOM. The
    // MessageLogger-style treatment uses the row itself and needs no marker.
    row.querySelectorAll(".alexandria-deleted-marker").forEach((marker) => marker.remove());
  });
}

function clearRenderedDeletedStyles() {
  document.querySelectorAll(".alexandria-deleted-message").forEach((row) => {
    row.classList.remove("alexandria-deleted-message");
    delete row.dataset.alexandriaDeleted;
  });
  document.querySelectorAll(".alexandria-deleted-marker").forEach((marker) => marker.remove());
}

function markDeletedMessageAfterRender(messageId, channelId) {
  // The retained row can be re-rendering while Discord processes the blocked
  // delete event. Try again on the next two render turns without keeping a
  // permanent observer alive.
  markRenderedMessageDeleted(messageId, channelId);
  [0, 100].forEach((delay) => setTimeout(() => markRenderedMessageDeleted(messageId, channelId), delay));
}

function captureRenderedMessage(element) {
  if (!element || element.dataset.alexandriaCaptured) return;
  if (store.captureEnabled === false) return;

  const message = messageWithRenderedAttachmentUrls(messageFromRenderedElement(element), element);
  // Do not mark the element until its fiber has yielded a message. React can
  // briefly render the element before the message props are attached.
  if (!message) return;
  if (!rememberMessage(message)) return;
  element.dataset.alexandriaCaptured = "1";

  const archived = entries().find((entry) => entry.id === asString(message.id));
  if (archived?.deleted) markDeletedMessageAfterRender(archived.id, archived.channelId);
}

function captureLoadedMessages() {
  if (store.captureEnabled === false) return;

  // Existing messages do not dispatch MESSAGE_CREATE while Alexandria is
  // starting. Scan the rendered DOM directly so messages sent earlier in the
  // session are archived before a later delete event can remove them.
  const elements = document.querySelectorAll(
    '[id^="message-username-"], [id^="message-content-"], [id^="message-"], img[src*="/attachments/"]',
  );
  elements.forEach(captureRenderedMessage);
}

function channelIdFromUrl(url) {
  return url?.match(/\/channels\/(\d+)\/messages/)?.[1] || "";
}

async function captureSentMessage(request, send) {
  const response = await send(request);
  const responseMessage = messageFromPayload(response?.body);

  if (responseMessage) {
    rememberMessage({
      ...responseMessage,
      channel_id: responseMessage.channel_id || channelIdFromUrl(request?.url),
    });
  }

  return response;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function serverLabel(entry) {
  return entry.guildName || (entry.guildId ? `Server ${entry.guildId}` : "Direct messages");
}

function serverKey(entry) {
  return entry.guildId || "@direct-messages";
}

function userKey(entry) {
  return entry.authorId || `@${entry.username || entry.author}`;
}

function userLabel(entry) {
  return entry.username && entry.username !== entry.author ? `${entry.author} (@${entry.username})` : entry.author;
}

function directMessageLabel(entry) {
  if (entry.guildId) return "";

  // Resolve the current channel too, so entries captured before this field was
  // added can still be searched by their DM recipient.
  const channel = fluxStores.ChannelStore?.getChannel?.(entry.channelId);
  return entry.directMessageName || directMessageName(channel) || `Direct message (${entry.channelId})`;
}

function channelLabel(entry) {
  if (!entry.guildId) return `DM: ${directMessageLabel(entry)}`;

  const currentChannel = fluxStores.ChannelStore?.getChannel?.(entry.channelId);
  const name = entry.channelName || channelName(currentChannel);
  return name ? `#${name} · ${serverLabel(entry)}` : `Channel ${entry.channelId} · ${serverLabel(entry)}`;
}

function removeArchiveEntry(messageId) {
  const current = entries();
  const entry = current.find((item) => item.id === messageId);

  if (entry?.deleted) {
    try {
      if (visibleDeletedMessages.has(entry.id)) releaseDeletedMessage(entry.id, entry.channelId);
      else {
        fluxDispatcher?.dispatch?.({
          type: "MESSAGE_DELETE",
          channelId: entry.channelId,
          id: entry.id,
          alexandriaRemove: true,
        });
      }
    } catch {
      // The archive copy can still be removed if Discord's local row already
      // disappeared or its internal store shape changed.
    }
  }

  const next = current.filter((entry) => entry.id !== messageId);
  if (next.length !== current.length) {
    store[ARCHIVE_KEY] = next;
    void deletePhotoBlobs(entryPhotoKeys(entry)).catch((error) => {
      console.error("[Alexandria] Could not remove archived photo blobs", error);
    });
  }
}

function removeDuplicateDomIds(element) {
  if (element instanceof Element) element.removeAttribute("id");
  element.querySelectorAll?.("[id]").forEach((child) => child.removeAttribute("id"));
}

function replaceMenuItemLabel(item, label) {
  const candidates = [...item.querySelectorAll("span, div")]
    .filter((element) => element.children.length === 0 && element.textContent.trim());
  const textElement = candidates.find((element) => /delete message|report message/i.test(element.textContent));
  if (textElement) textElement.textContent = label;
  else item.textContent = label;
}

function addArchiveContextMenuItem(message) {
  const entry = entries().find((item) => item.id === asString(message?.id));
  // Match MessageLogger's scope: this is a cleanup action for a deleted
  // message, not an extra item on every ordinary message's context menu.
  if (!entry?.deleted) return;

  const menus = [...document.querySelectorAll('[role="menu"]')];
  const menu = menus.at(-1);
  if (!menu || menu.querySelector('[data-alexandria-remove-message]')) return;

  const menuItems = [...menu.querySelectorAll('[role="menuitem"]')];
  const reference =
    menuItems.find((item) => /delete message/i.test(item.textContent)) ||
    menuItems.find((item) => /report message/i.test(item.textContent)) ||
    menuItems.at(-1);
  if (!reference?.parentElement) return;

  const item = reference.cloneNode(true);
  removeDuplicateDomIds(item);
  replaceMenuItemLabel(item, "Remove from Alexandria archive");
  item.dataset.alexandriaRemoveMessage = entry.id;
  item.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    removeArchiveEntry(entry.id);
    menu.remove();
  });
  reference.insertAdjacentElement("afterend", item);
}

function handleMessageContextMenu(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const messageElement = target.closest('[id^="message-"], [data-list-item-id^="chat-messages-"]');
  const message = messageFromRenderedElement(messageElement);
  if (!message?.id || !entries().some((entry) => entry.id === asString(message.id) && entry.deleted)) return;

  setTimeout(() => addArchiveContextMenuItem(message), 0);
}

function SearchablePicker(props) {
  const selectedLabel = () => props.options().find((option) => option.value === props.value)?.label || "";
  const [inputValue, setInputValue] = createSignal(selectedLabel());

  createEffect(() => {
    const value = props.value;
    setInputValue(value ? selectedLabel() : "");
  });

  function updateInput(value) {
    setInputValue(value);
    const match = props.options().find(
      (option) => option.label.localeCompare(value.trim(), undefined, { sensitivity: "accent" }) === 0,
    );

    if (match) props.onChange(match.value);
    if (!value.trim()) props.onChange("");
  }

  function clear() {
    setInputValue("");
    props.onChange("");
  }

  return (
    <div class="alexandria-picker">
      <input
        class="alexandria-picker-input"
        value={inputValue()}
        list={`${props.id}-options`}
        placeholder={props.placeholder}
        aria-label={props.ariaLabel}
        onInput={(event) => updateInput(event.currentTarget.value)}
      />
      <datalist id={`${props.id}-options`}>
        <For each={props.options()}>{(option) => <option value={option.label} />}</For>
      </datalist>
      <Show when={props.value}>
        <button class="alexandria-picker-clear" type="button" onClick={clear} aria-label={`Clear ${props.placeholder}`}>
          ×
        </button>
      </Show>
    </div>
  );
}

function archiveCount() {
  return entries().filter((entry) => entry.deleted).length;
}

function capturedCount() {
  return entries().length;
}

function storageBytes() {
  // Blob sizes are tracked in metadata, so this remains cheap even when the
  // disk-backed photo archive is large.
  return entries().reduce((total, entry) => total + archiveEntryBytes(entry), 0);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  const precision = unitIndex === 0 || value >= 10 ? 0 : 1;

  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function guildChoices() {
  const choices = new Map();
  const guilds = fluxStores.GuildStore?.getGuilds?.() || {};

  Object.values(guilds).forEach((guild) => {
    const id = asString(guild?.id);
    if (id) choices.set(id, asString(guild?.name, `Server ${id}`));
  });
  entries().forEach((entry) => {
    if (entry.guildId && !choices.has(entry.guildId)) choices.set(entry.guildId, serverLabel(entry));
  });

  return [...choices.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
}

function directMessageChoices() {
  const choices = new Map();
  const privateChannelStore = fluxStores.PrivateChannelStore;
  const privateChannelSortStore = fluxStores.PrivateChannelSortStore;
  const channelStore = fluxStores.ChannelStore;
  const addChannel = (candidate, depth = 0) => {
    if (!candidate || depth > 3) return;

    if (typeof candidate === "string" || typeof candidate === "number") {
      addChannel(channelStore?.getChannel?.(asString(candidate)), depth + 1);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => addChannel(item, depth + 1));
      return;
    }
    if (candidate instanceof Map || candidate instanceof Set) {
      candidate.forEach((item) => addChannel(item, depth + 1));
      return;
    }

    const id = asString(candidate?.id);
    if (id) {
      // Sources below are private-channel stores, but retain this guard in
      // case Discord changes one of them to return a mixed channel map.
      if (!asString(candidate?.guild_id || candidate?.guildId)) {
        choices.set(id, directMessageName(candidate) || asString(candidate?.name, `Direct message ${id}`));
      }
      return;
    }

    if (typeof candidate === "object") {
      Object.values(candidate).forEach((item) => addChannel(item, depth + 1));
    }
  };
  const sources = [
    privateChannelStore?.getPrivateChannels?.(),
    privateChannelStore?.getPrivateChannelIds?.(),
    privateChannelStore?.getSortedPrivateChannels?.(),
    channelStore?.getPrivateChannels?.(),
    channelStore?.getMutablePrivateChannels?.(),
    channelStore?.getSortedPrivateChannels?.(),
    privateChannelSortStore?.getPrivateChannelIds?.(),
    privateChannelSortStore?.getSortedPrivateChannels?.(),
  ];

  sources.forEach((source) => addChannel(source));

  // Some Discord builds expose DMs only through relationship-to-channel
  // lookups rather than a complete private-channel collection.
  const relationships = fluxStores.RelationshipStore?.getRelationships?.() || {};
  const relationshipUserIds = relationships instanceof Map
    ? [...relationships.keys()]
    : Object.keys(relationships);
  relationshipUserIds.forEach((userId) => {
    const dm =
      channelStore?.getDMFromUserId?.(userId) ||
      privateChannelStore?.getDMFromUserId?.(userId);
    addChannel(dm);
  });

  const currentChannel = channelStore?.getChannel?.(selectedChannelId());
  if (currentChannel && !asString(currentChannel.guild_id || currentChannel.guildId)) addChannel(currentChannel);

  entries().forEach((entry) => {
    if (!entry.guildId && entry.channelId && !choices.has(entry.channelId)) {
      choices.set(entry.channelId, directMessageLabel(entry));
    }
  });

  return [...choices.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
}

function activeScopeLabel() {
  const channelId = selectedChannelId();
  const channel = fluxStores.ChannelStore?.getChannel?.(channelId);
  const guildId = asString(channel?.guild_id || channel?.guildId);

  if (guildId) {
    const guild = fluxStores.GuildStore?.getGuild?.(guildId);
    return asString(guild?.name, `Server ${guildId}`);
  }
  return directMessageName(channel) || (channelId ? `Direct message ${channelId}` : "No conversation selected");
}

function CaptureScopeSettings() {
  const [mode, setMode] = createSignal(asString(store.captureMode, "all"));
  const [activeMode, setActiveMode] = createSignal(store.activeMode === true);
  const [guildIds, setGuildIds] = createSignal(storedIdList("selectedGuildIds"));
  const [directMessageIds, setDirectMessageIds] = createSignal(storedIdList("selectedDirectMessageIds"));

  const setCaptureMode = (value) => {
    const nextMode = asString(value, "all");
    setMode(nextMode);
    store.captureMode = nextMode;
    if (store.captureEnabled !== false) setTimeout(captureLoadedMessages, 0);
  };

  const toggleChoice = (key, value, checked, setter) => {
    const current = storedIdList(key);
    const next = checked
      ? [...new Set([...current, value])]
      : current.filter((id) => id !== value);
    store[key] = next;
    setter(next);
    if (checked && mode() === "selected" && store.captureEnabled !== false) {
      setTimeout(captureLoadedMessages, 0);
    }
  };

  return (
    <section class="alexandria-scope">
      <SwitchItem
        checked={activeMode()}
        onChange={(value) => {
          const enabled = Boolean(value);
          setActiveMode(enabled);
          store.activeMode = enabled;
          if (enabled && store.captureEnabled !== false) setTimeout(captureLoadedMessages, 0);
        }}
        note={`Also record the server or DM currently open (${activeScopeLabel()}), even when it is not selected below. Existing selections keep recording, and the global Capture messages switch remains authoritative.`}
      >
        Active mode
      </SwitchItem>
      <label class="alexandria-settings-label" for="alexandria-capture-mode">Recording scope</label>
      <Select
        id="alexandria-capture-mode"
        value={mode()}
        aria-label="Choose which conversations Alexandria records"
        onChange={setCaptureMode}
      >
        <SelectOption value="all">All servers and direct messages</SelectOption>
        <SelectOption value="selected">Selected servers and direct messages</SelectOption>
      </Select>
      <p class="alexandria-settings-note">
        {mode() === "selected"
          ? "Messages from the checked servers and direct messages are recorded. Active mode can add the currently open conversation."
          : "Messages Alexandria sees in every server and direct message are recorded."}
      </p>

      <Show when={mode() === "selected"}>
        <div class="alexandria-scope-columns">
          <section class="alexandria-scope-group" aria-labelledby="alexandria-servers-heading">
            <h3 id="alexandria-servers-heading" class="alexandria-scope-heading">Servers</h3>
            <div class="alexandria-scope-list">
              <Show when={guildChoices().length} fallback={<span class="alexandria-scope-empty">No servers found</span>}>
                <For each={guildChoices()}>
                  {(choice) => (
                    <label class="alexandria-scope-choice">
                      <input
                        type="checkbox"
                        checked={guildIds().includes(choice.value)}
                        onChange={(event) =>
                          toggleChoice("selectedGuildIds", choice.value, event.currentTarget.checked, setGuildIds)
                        }
                      />
                      <span>{choice.label}</span>
                    </label>
                  )}
                </For>
              </Show>
            </div>
          </section>
          <section class="alexandria-scope-group" aria-labelledby="alexandria-direct-messages-heading">
            <h3 id="alexandria-direct-messages-heading" class="alexandria-scope-heading">Direct messages</h3>
            <div class="alexandria-scope-list">
              <Show when={directMessageChoices().length} fallback={<span class="alexandria-scope-empty">No direct messages found</span>}>
                <For each={directMessageChoices()}>
                  {(choice) => (
                    <label class="alexandria-scope-choice">
                      <input
                        type="checkbox"
                        checked={directMessageIds().includes(choice.value)}
                        onChange={(event) =>
                          toggleChoice(
                            "selectedDirectMessageIds",
                            choice.value,
                            event.currentTarget.checked,
                            setDirectMessageIds,
                          )
                        }
                      />
                      <span>{choice.label}</span>
                    </label>
                  )}
                </For>
              </Show>
            </div>
          </section>
        </div>
      </Show>
    </section>
  );
}

function repairMissingArchivedPhoto(messageId, attachment) {
  const repairKey = `${messageId}:${attachmentKey(attachment)}`;
  if (photoRepairsInFlight.has(repairKey)) return;
  photoRepairsInFlight.add(repairKey);

  try {
    const current = entries();
    const entryIndex = current.findIndex((entry) => entry.id === messageId);
    if (entryIndex === -1) return;
    const attachments = current[entryIndex].attachments.map((item) => {
      if (attachmentKey(item) !== attachmentKey(attachment) || item.blobKey !== attachment.blobKey) {
        return item;
      }
      const { blobKey, cachedBytes, ...metadata } = item;
      return { ...metadata, photoUnavailable: false };
    });
    if (sameJSON(attachments, current[entryIndex].attachments)) return;
    const next = [...current];
    next[entryIndex] = { ...next[entryIndex], attachments };
    store[ARCHIVE_KEY] = next;
    const repairedAttachment = attachments.find(
      (item) => attachmentKey(item) === attachmentKey(attachment),
    );
    if (repairedAttachment) cachePhotos(messageId, [repairedAttachment]);
  } finally {
    photoRepairsInFlight.delete(repairKey);
  }
}

function createArchivedPhotoResource(blobKey, onMissing) {
  const [source, setSource] = createSignal("");
  const [blob, setBlob] = createSignal(null);
  const [error, setError] = createSignal(false);

  createEffect(() => {
    const key = blobKey();
    let disposed = false;
    let objectUrl = "";
    setSource("");
    setBlob(null);
    setError(false);

    if (key) {
      void readPhotoBlob(key)
        .then((photo) => {
          if (disposed) return;
          if (!(photo instanceof Blob)) {
            setError(true);
            onMissing?.();
            return;
          }
          objectUrl = URL.createObjectURL(photo);
          setBlob(photo);
          setSource(objectUrl);
        })
        .catch(() => {
          if (!disposed) setError(true);
        });
    }

    onCleanup(() => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    });
  });

  return { source, blob, error };
}

function ArchivedPhoto(props) {
  const [shouldLoad, setShouldLoad] = createSignal(false);
  let host;
  let observer;
  const photo = createArchivedPhotoResource(
    () => (shouldLoad() ? props.attachment.blobKey : ""),
    () => repairMissingArchivedPhoto(props.messageId, props.attachment),
  );

  onMount(() => {
    if (typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }
    observer = new IntersectionObserver(
      (records) => {
        if (!records.some((record) => record.isIntersecting)) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: "300px" },
    );
    observer.observe(host);
  });
  onCleanup(() => observer?.disconnect());

  return (
    <div class="alexandria-photo-loader" ref={host}>
      <Show
        when={photo.source()}
        fallback={
          <div class="alexandria-extra-item alexandria-photo-status">
            {photo.error() ? "Archived photo is unavailable." : "Loading archived photo…"}
          </div>
        }
      >
        <button
          class="alexandria-photo"
          type="button"
          onClick={() => openPhoto(props.attachment, props.messageId)}
          aria-label={`Enlarge and copy ${props.attachment.filename || "archived photo"}`}
          title={props.attachment.filename}
        >
          <img loading="lazy" decoding="async" src={photo.source()} alt={props.attachment.filename} />
          <span class="alexandria-photo-hint" aria-hidden="true">Enlarge</span>
        </button>
      </Show>
    </div>
  );
}

function PhotoModal(props) {
  const [copyState, setCopyState] = createSignal("idle");
  const photo = createArchivedPhotoResource(
    () => props.attachment.blobKey,
    () => repairMissingArchivedPhoto(props.messageId, props.attachment),
  );

  const handleCopy = async () => {
    if (!photo.blob()) return;
    setCopyState("copying");

    try {
      await copyPhoto(photo.blob());
      setCopyState("copied");
    } catch (error) {
      console.error("[Alexandria] Could not copy archived photo", error);
      setCopyState("error");
    }
  };

  return (
    <ModalRoot size={ModalSizes.LARGE} class="alexandria-modal alexandria-photo-modal">
      <ModalHeader close={props.close}>
        <div class="alexandria-photo-modal-title">
          <strong>{props.attachment.filename || "Archived photo"}</strong>
          <small>Saved locally by Alexandria</small>
        </div>
      </ModalHeader>
      <ModalBody>
        <Show
          when={photo.source()}
          fallback={
            <div class="alexandria-photo-preview alexandria-photo-status">
              {photo.error() ? "Archived photo is unavailable." : "Loading archived photo…"}
            </div>
          }
        >
          <div class="alexandria-photo-preview">
            <img src={photo.source()} alt={props.attachment.filename || "Archived photo"} />
          </div>
        </Show>
        <div class="alexandria-copy-status" role="status" aria-live="polite">
          <Show when={copyState() === "copied"}>Photo copied to your clipboard.</Show>
          <Show when={copyState() === "error"}>Couldn’t copy the photo in this Discord client.</Show>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button
          size={ButtonSizes.MIN}
          color={ButtonColors.SECONDARY}
          onClick={props.close}
        >
          Close
        </Button>
        <Button
          size={ButtonSizes.MIN}
          onClick={handleCopy}
          disabled={!photo.blob() || copyState() === "copying"}
        >
          {copyState() === "copying" ? "Copying…" : copyState() === "copied" ? "Copied!" : "Copy image"}
        </Button>
      </ModalFooter>
    </ModalRoot>
  );
}

function openPhoto(attachment, messageId) {
  removePhotoModal?.();
  removePhotoModal = openModal((props) => (
    <PhotoModal {...props} attachment={attachment} messageId={messageId} />
  ));
}

function ArchiveModal(props) {
  const [query, setQuery] = createSignal("");
  const [showAll, setShowAll] = createSignal(false);
  const [sortMode, setSortMode] = createSignal(store.sortMode || "deletedAt");
  const [selectedServer, setSelectedServer] = createSignal(store.serverFilter || "");
  const [selectedUser, setSelectedUser] = createSignal(store.userFilter || "");
  const [selectedDirectMessage, setSelectedDirectMessage] = createSignal(store.directMessageFilter || "");
  const [resultLimit, setResultLimit] = createSignal(ARCHIVE_PAGE_SIZE);

  const serverOptions = () => {
    const options = new Map();

    entries().forEach((entry) => {
      const key = serverKey(entry);
      if (!options.has(key)) options.set(key, serverLabel(entry));
    });

    return [...options.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
  };

  const userOptions = () => {
    const options = new Map();

    entries().forEach((entry) => {
      const key = userKey(entry);
      if (!options.has(key)) options.set(key, userLabel(entry));
    });

    return [...options.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
  };

  const directMessageOptions = () => {
    const options = new Map();

    entries().filter((entry) => !entry.guildId).forEach((entry) => {
      if (!options.has(entry.channelId)) options.set(entry.channelId, directMessageLabel(entry));
    });

    return [...options.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
  };

  const visibleEntries = createMemo(() => {
    const search = query().trim().toLowerCase();

    return entries()
      .filter((entry) => showAll() || entry.deleted)
      .filter((entry) => !selectedServer() || serverKey(entry) === selectedServer())
      .filter((entry) => !selectedUser() || userKey(entry) === selectedUser())
      .filter((entry) => !selectedDirectMessage() || entry.channelId === selectedDirectMessage())
      .filter((entry) => {
        if (!search) return true;
        return `${entry.author} ${entry.username} ${entry.content} ${entry.channelId} ${directMessageLabel(entry)}`
          .toLowerCase()
          .includes(search);
      })
      .slice()
      .sort((left, right) => {
        if (sortMode() === "user") {
          const userOrder = left.author.localeCompare(right.author, undefined, { sensitivity: "base" });
          if (userOrder !== 0) return userOrder;
        }

        if (sortMode() === "server") {
          const serverOrder = serverLabel(left).localeCompare(serverLabel(right), undefined, {
            sensitivity: "base",
          });
          if (serverOrder !== 0) return serverOrder;
        }

        const leftTime = archiveActivityTime(left);
        const rightTime = archiveActivityTime(right);
        return rightTime - leftTime;
      });
  });

  const displayedEntries = () => visibleEntries().slice(0, resultLimit());

  // A changed query, filter, view, or sort should always start at the first
  // page, rather than leaving the user at an arbitrary old page length.
  createEffect(() => {
    query();
    showAll();
    sortMode();
    selectedServer();
    selectedUser();
    selectedDirectMessage();
    setResultLimit(ARCHIVE_PAGE_SIZE);
  });

  const activeFilterCount = () =>
    [query().trim(), selectedServer(), selectedUser(), selectedDirectMessage()].filter(Boolean).length;

  const resetFilters = () => {
    setQuery("");
    setSelectedServer("");
    setSelectedUser("");
    setSelectedDirectMessage("");
    store.serverFilter = "";
    store.userFilter = "";
    store.directMessageFilter = "";
  };

  return (
    <ModalRoot size={ModalSizes.LARGE} class="alexandria-modal">
      <ModalHeader close={props.close}>
        <div class="alexandria-modal-title">
          <span class="alexandria-modal-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M5.5 5.75A2.75 2.75 0 0 1 8.25 3H11v15H8.25a2.75 2.75 0 0 0-2.75 2.75v-15Zm13 0A2.75 2.75 0 0 0 15.75 3H13v15h2.75a2.75 2.75 0 0 1 2.75 2.75v-15Z" />
            </svg>
          </span>
          <span>
            <strong>Alexandria</strong>
            <small>Message archive</small>
          </span>
        </div>
      </ModalHeader>
      <ModalBody>
        <div class="alexandria-overview" aria-label="Archive overview">
          <div class="alexandria-overview-copy">
            <span class="alexandria-eyebrow">Local archive</span>
            <strong>{archiveCount()} deleted message{archiveCount() === 1 ? "" : "s"} preserved</strong>
            <p>Search what Alexandria captured, then narrow it by conversation or person.</p>
          </div>
          <div class="alexandria-stat" title="Total messages currently stored">
            <span>{capturedCount()}</span>
            <small>captured</small>
          </div>
        </div>

        <div class="alexandria-filter-panel">
          <div class="alexandria-search">
            <span class="alexandria-search-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="m20 20-4.3-4.3m2.3-5.2a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" /></svg>
            </span>
            <TextBox
              value={query()}
              placeholder="Search messages, people, or channels…"
              aria-label="Search the Alexandria archive"
              onInput={setQuery}
            />
          </div>
          <div class="alexandria-toolbar">
            <SearchablePicker
              id="alexandria-server-filter"
              value={selectedServer()}
              options={serverOptions}
              placeholder="All servers"
              ariaLabel="Filter Alexandria archive by server"
              onChange={(value) => {
                const server = String(value);
                setSelectedServer(server);
                store.serverFilter = server;
              }}
            />
            <SearchablePicker
              id="alexandria-user-filter"
              value={selectedUser()}
              options={userOptions}
              placeholder="All people"
              ariaLabel="Filter Alexandria archive by user"
              onChange={(value) => {
                const user = String(value);
                setSelectedUser(user);
                store.userFilter = user;
              }}
            />
            <SearchablePicker
              id="alexandria-direct-message-filter"
              value={selectedDirectMessage()}
              options={directMessageOptions}
              placeholder="All direct messages"
              ariaLabel="Filter Alexandria archive by direct message"
              onChange={(value) => {
                const directMessage = String(value);
                setSelectedDirectMessage(directMessage);
                store.directMessageFilter = directMessage;
              }}
            />
            <Select
              value={sortMode()}
              aria-label="Sort Alexandria archive"
              onChange={(value) => {
                const mode = String(value);
                setSortMode(mode);
                store.sortMode = mode;
              }}
            >
              <SelectOption value="deletedAt">Newest activity</SelectOption>
              <SelectOption value="user">Person A–Z</SelectOption>
              <SelectOption value="server">Server A–Z</SelectOption>
            </Select>
          </div>
        </div>

        <div class="alexandria-summary">
          <div class="alexandria-view-toggle" role="group" aria-label="Choose which messages to show">
            <button classList={{ active: !showAll() }} type="button" onClick={() => setShowAll(false)}>
              Deleted
            </button>
            <button classList={{ active: showAll() }} type="button" onClick={() => setShowAll(true)}>
              All archived
            </button>
          </div>
          <span class="alexandria-result-count">
            <strong>{visibleEntries().length}</strong> result{visibleEntries().length === 1 ? "" : "s"}
          </span>
          <Show when={activeFilterCount() > 0}>
            <button class="alexandria-clear-filters" type="button" onClick={resetFilters}>
              Clear filters <span>{activeFilterCount()}</span>
            </button>
          </Show>
        </div>

        <Show
          when={visibleEntries().length > 0}
          fallback={
            <div class="alexandria-empty">
              <span class="alexandria-empty-icon" aria-hidden="true">⌕</span>
              <strong>{activeFilterCount() ? "No matching messages" : "Nothing archived yet"}</strong>
              <p>
                {activeFilterCount()
                  ? "Try a broader search or clear the active filters."
                  : showAll()
                    ? "Captured messages will appear here as Alexandria sees them."
                    : "Deleted messages will appear here after Alexandria captures them."}
              </p>
              <Show when={activeFilterCount() > 0}>
                <button type="button" onClick={resetFilters}>Clear all filters</button>
              </Show>
            </div>
          }
        >
          <div class="alexandria-list">
            <For each={displayedEntries()}>
              {(entry) => (
                <article class={`alexandria-entry ${entry.deleted ? "is-deleted" : "is-captured"}`}>
                  <div class="alexandria-entry-heading">
                    <div class="alexandria-identity">
                      <span class="alexandria-avatar" aria-hidden="true">{asString(entry.author, "?").slice(0, 1)}</span>
                      <div>
                        <span class="alexandria-author">{entry.author}</span>
                        <Show when={entry.username && entry.username !== entry.author}>
                          <span class="alexandria-username">@{entry.username}</span>
                        </Show>
                      </div>
                    </div>
                    <span class="alexandria-status">{entry.deleted ? "Deleted" : "Saved"}</span>
                  </div>
                  <div class="alexandria-meta">
                    <span class="alexandria-location">{channelLabel(entry)}</span>
                    <time datetime={entry.timestamp}>Sent {formatDate(entry.timestamp)}</time>
                    <Show when={entry.deletedAt}>
                      <time datetime={entry.deletedAt}>Removed {formatDate(entry.deletedAt)}</time>
                    </Show>
                  </div>
                  <Show when={entry.content}>
                    <p class="alexandria-content">{entry.content}</p>
                  </Show>
                  <Show when={entry.embeds?.length}>
                    <div class="alexandria-extra">
                      <For each={entry.embeds}>
                        {(embed) => (
                          <div class="alexandria-extra-item">
                            <strong>{embed.title || "Embed"}</strong>
                            <Show when={embed.description}>
                              <span> — {embed.description}</span>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={entry.attachments?.length}>
                    <div class="alexandria-extra">
                      <For each={entry.attachments}>
                        {(attachment) => (
                          <Show
                            when={attachment.isImage}
                            fallback={<div class="alexandria-extra-item">↗ {attachment.filename}</div>}
                          >
                            <Show
                              when={attachment.blobKey}
                              fallback={
                                <div class="alexandria-extra-item alexandria-photo-status">
                                  {attachment.photoUnavailable
                                    ? "Photo could not be saved locally."
                                    : "Saving photo locally…"}
                                </div>
                              }
                            >
                              <ArchivedPhoto attachment={attachment} messageId={entry.id} />
                            </Show>
                          </Show>
                        )}
                      </For>
                    </div>
                  </Show>
                  <div class="alexandria-entry-actions">
                    <button
                      class="alexandria-remove-entry"
                      type="button"
                      onClick={() => removeArchiveEntry(entry.id)}
                      aria-label={`Remove ${userLabel(entry)}'s message from the Alexandria archive`}
                    >
                      Remove from archive
                    </button>
                  </div>
                </article>
              )}
            </For>
            <Show when={visibleEntries().length > resultLimit()}>
              <button
                class="alexandria-load-more"
                type="button"
                onClick={() => setResultLimit((limit) => limit + ARCHIVE_PAGE_SIZE)}
              >
                Show {Math.min(ARCHIVE_PAGE_SIZE, visibleEntries().length - resultLimit())} more
              </button>
            </Show>
          </div>
        </Show>
      </ModalBody>
      <ModalFooter>
        <Button size={ButtonSizes.MIN} color={ButtonColors.SECONDARY} onClick={props.close}>
          Hide archive
        </Button>
      </ModalFooter>
    </ModalRoot>
  );
}

function openArchive() {
  captureLoadedMessages();
  if (store.photoBackfillEnabled) backfillArchivedPhotos();
  removeModal?.();
  removeModal = openModal((props) => <ArchiveModal {...props} />);
}

async function clearArchive() {
  try {
    await openConfirmationModal({
      header: () => "Clear Alexandria archive?",
      body: () => "This permanently removes every locally saved entry. This cannot be undone.",
      type: "danger",
      confirmText: "Clear archive",
      cancelText: "Keep archive",
    });
    const archivedPhotoKeys = entries().flatMap(entryPhotoKeys);
    store[ARCHIVE_KEY] = [];
    await deletePhotoBlobs(archivedPhotoKeys);
  } catch {
    // Closing or cancelling the confirmation leaves the archive untouched.
  }
}

function clampLauncherPosition(x, y, button) {
  const margin = 8;
  return {
    x: Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - button.offsetWidth - margin)),
    y: Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - button.offsetHeight - margin)),
  };
}

function placeLauncher(x, y, persist = false) {
  const button = launcherHost?.querySelector(".alexandria-launcher");
  if (!button) return;

  const position = clampLauncherPosition(x, y, button);
  launcherHost.style.left = `${position.x}px`;
  launcherHost.style.top = `${position.y}px`;
  launcherHost.style.right = "auto";
  launcherHost.style.bottom = "auto";
  if (persist) store.launcherPosition = position;
}

function restoreLauncherPosition() {
  const position = store.launcherPosition;
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return;
  placeLauncher(position.x, position.y, true);
}

function beginLauncherDrag(event) {
  if (event.button !== 0 || !event.isPrimary) return;

  const button = event.currentTarget;
  const start = { x: event.clientX, y: event.clientY };
  const rect = launcherHost.getBoundingClientRect();
  let moved = false;

  stopLauncherDrag?.();
  button.setPointerCapture?.(event.pointerId);

  const onMove = (moveEvent) => {
    if (moveEvent.pointerId !== event.pointerId) return;
    const deltaX = moveEvent.clientX - start.x;
    const deltaY = moveEvent.clientY - start.y;

    if (!moved && Math.hypot(deltaX, deltaY) < 4) return;
    moved = true;
    button.classList.add("is-dragging");
    placeLauncher(rect.left + deltaX, rect.top + deltaY);
  };

  const finish = (upEvent) => {
    if (upEvent.pointerId !== event.pointerId) return;
    if (moved) {
      const finalRect = launcherHost.getBoundingClientRect();
      placeLauncher(finalRect.left, finalRect.top, true);
      suppressLauncherClick = true;
      setTimeout(() => {
        suppressLauncherClick = false;
      }, 0);
    }
    stopLauncherDrag?.();
  };

  stopLauncherDrag = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    button.classList.remove("is-dragging");
    stopLauncherDrag = null;
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
}

function handleLauncherClick(event) {
  if (suppressLauncherClick) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  openArchive();
}

function mountLauncher() {
  document.getElementById(launcherId)?.remove();
  launcherHost = document.createElement("div");
  launcherHost.id = launcherId;
  document.body.append(launcherHost);
  launcherHost.append(
    <ReactiveRoot>
      <Show when={store.showButton}>
        <button
          class="alexandria-launcher"
          ref={() => requestAnimationFrame(restoreLauncherPosition)}
          onClick={handleLauncherClick}
          onPointerDown={beginLauncherDrag}
          aria-label="Open Alexandria archive; drag to move"
          title="Drag to move · Click to open"
        >
          <svg class="alexandria-launcher-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4.5 5.75A2.75 2.75 0 0 1 7.25 3H11v15H7.25A2.75 2.75 0 0 0 4.5 20.75V5.75Zm15 0A2.75 2.75 0 0 0 16.75 3H13v15h3.75a2.75 2.75 0 0 1 2.75 2.75V5.75Z" />
            <path d="M4.5 20.75c0-.76.62-1.38 1.38-1.38H11v1.63H5.88A1.38 1.38 0 0 1 4.5 19.62v1.13Zm15 0c0-.76-.62-1.38-1.38-1.38H13v1.63h5.12a1.38 1.38 0 0 0 1.38-1.38v1.13Z" />
          </svg>
          <span>Alexandria</span>
          <Show when={archiveCount() > 0}>
            <span class="alexandria-count">{archiveCount()}</span>
          </Show>
        </button>
      </Show>
    </ReactiveRoot>,
  );
}

scoped.ui.injectCss(styles);

export function onLoad() {
  pluginUnloading = false;
  void prepareMediaDatabase().catch((error) => {
    console.error("[Alexandria] Could not prepare the photo database", error);
  });
  // Remove badges left in the DOM by Alexandria versions that predate the
  // MessageLogger-style deleted-message treatment.
  document.querySelectorAll(".alexandria-deleted-marker").forEach((marker) => marker.remove());
  scoped.onDispose(clearRenderedDeletedStyles);
  window.addEventListener("resize", restoreLauncherPosition);
  scoped.onDispose(() => {
    window.removeEventListener("resize", restoreLauncherPosition);
    stopLauncherDrag?.();
  });

  const unobserve = scoped.observeDom(
    '[id^="message-username-"], [id^="message-content-"], img[src*="/attachments/"]',
    captureRenderedMessage,
  );
  unobserve.now();
  scoped.onDispose(unobserve);

  captureLoadedMessages();
  const backfillTimers = [0, 250, 750, 1500, 3000].map((delay) =>
    setTimeout(captureLoadedMessages, delay),
  );
  scoped.onDispose(() => backfillTimers.forEach(clearTimeout));

  // Intercept before Discord's stores process the action. This is especially
  // important for messages that are deleted before React has re-rendered them.
  const stopFluxIntercept = scoped.flux.intercept(handleDispatch);
  scoped.onDispose(stopFluxIntercept);

  // The send response contains the complete message object, which gives us a
  // reliable fallback for messages authored locally (including quick deletes).
  const stopMessageInterceptor = scoped.http.intercept(
    "post",
    (url) => /\/channels\/\d+\/messages(?:\?|$)/.test(url),
    captureSentMessage,
  );
  scoped.onDispose(stopMessageInterceptor);

  document.addEventListener("contextmenu", handleMessageContextMenu, true);
  scoped.onDispose(() => document.removeEventListener("contextmenu", handleMessageContextMenu, true));

  mountLauncher();
}

export const settings = () => (
  <div class="alexandria-settings">
    <SwitchItem
      checked={store.captureEnabled}
      onChange={(value) => {
        store.captureEnabled = value;
      }}
      note="Alexandria can only preserve messages it sees while the plugin is enabled."
    >
      Capture messages
    </SwitchItem>
    <CaptureScopeSettings />
    <SwitchItem
      checked={store.showButton}
      onChange={(value) => {
        store.showButton = value;
      }}
      note="The button only opens the archive; closing it hides the archive again."
    >
      Show Alexandria launcher
    </SwitchItem>
    <SwitchItem
      checked={store.photoBackfillEnabled}
      onChange={(value) => {
        store.photoBackfillEnabled = value;
        if (value) backfillArchivedPhotos();
      }}
      note="Try to save local copies of photos from earlier archive entries while their Discord media is still available. Downloads run three at a time."
    >
      Backfill archived photos
    </SwitchItem>
    <div class="alexandria-storage">
      <div class="alexandria-storage-heading">
        <span>Storage used</span>
        <strong>{formatBytes(storageBytes())}</strong>
      </div>
      <p>Approximate archive storage, including disk-backed photos. The rolling archive is capped at 2,000 entries or 2 GB; temporary pre-delete photo staging is separately capped at 300 MB.</p>
    </div>
    <div class="alexandria-settings-actions">
      <Button size={ButtonSizes.MIN} onClick={openArchive}>
        Open archive
      </Button>
      <Button size={ButtonSizes.MIN} color={ButtonColors.CRITICAL_SECONDARY} onClick={clearArchive}>
        Clear archive
      </Button>
    </div>
  </div>
);

export function onUnload() {
  pluginUnloading = true;
  clearTimeout(archiveTrimTimer);
  photoCaptureQueue.length = 0;
  queuedPhotoCaptures.clear();
  for (const [messageId, preview] of [...visibleDeletedMessages]) {
    releaseDeletedMessage(messageId, preview.channelId);
  }
  visibleDeletedMessageBytes = 0;
  const pendingPhotoKeys = [...pendingMessages.values()].flatMap(entryPhotoKeys);
  pendingMessages.clear();
  pendingMessageBytes = 0;
  pendingPhotoBytes = 0;
  removeModal?.();
  removeModal = undefined;
  removePhotoModal?.();
  removePhotoModal = undefined;
  void (async () => {
    try {
      await deletePhotoBlobs(pendingPhotoKeys);
      while (activePhotoCaptures > 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } catch {
      // Discord shutdown will close the database even if cleanup is cut short.
    } finally {
      try {
        (await mediaDatabasePromise)?.close();
      } catch {
        // The database may never have been opened in a text-only session.
      }
    }
  })();
  launcherHost?.remove();
  launcherHost = undefined;
}
