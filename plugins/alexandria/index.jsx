import { For, Show, createSignal } from "solid-js";
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
const launcherId = "alexandria-launcher-host";
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

store[ARCHIVE_KEY] ??= [];
store.captureEnabled ??= true;
store.showButton ??= true;
store.sortMode ??= "deletedAt";
store.serverFilter ??= "";
store.userFilter ??= "";
store.directMessageFilter ??= "";
store.photoBackfillEnabled ??= false;

let launcherHost;
let removeModal;
const photoCapturesInFlight = new Set();
const queuedPhotoCaptures = new Set();
const photoCaptureQueue = [];
let activePhotoCaptures = 0;

const entries = () => (Array.isArray(store[ARCHIVE_KEY]) ? store[ARCHIVE_KEY] : []);
const fluxStores = shelter.flux?.storesFlat || {};
const fluxDispatcher = shelter.flux?.dispatcher;

function asString(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value);
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
  const url = asString(attachment?.url);
  const proxyUrl = asString(attachment?.proxy_url || attachment?.proxyUrl);

  return {
    id: asString(attachment?.id),
    filename,
    url,
    proxyUrl,
    contentType,
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
    return captured?.dataUrl ? { ...attachment, dataUrl: captured.dataUrl } : attachment;
  });
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function setPhotoCaptureStatus(messageId, key, photoUnavailable) {
  const current = entries();
  const entryIndex = current.findIndex((entry) => entry.id === messageId);
  if (entryIndex === -1) return;

  const attachments = current[entryIndex].attachments.map((item) =>
    attachmentKey(item) === key ? { ...item, photoUnavailable } : item,
  );
  if (sameJSON(attachments, current[entryIndex].attachments)) return;

  const next = [...current];
  next[entryIndex] = { ...next[entryIndex], attachments };
  store[ARCHIVE_KEY] = next;
}

async function cachePhoto(messageId, attachment) {
  const sourceUrls = [...new Set([attachment.proxyUrl, attachment.url].filter(Boolean))];
  if (!attachment.isImage || sourceUrls.length === 0) return;

  const key = attachmentKey(attachment);
  const captureKey = `${messageId}:${key}`;
  if (photoCapturesInFlight.has(captureKey)) return;
  photoCapturesInFlight.add(captureKey);

  try {
    let blob;

    for (const sourceUrl of sourceUrls) {
      const response = await fetch(sourceUrl);
      const contentLength = Number(response.headers.get("content-length"));
      if (!response.ok || (contentLength && contentLength > MAX_PHOTO_BYTES)) continue;

      const candidate = await response.blob();
      if (candidate.size > MAX_PHOTO_BYTES) continue;

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

    const dataUrl = await readBlobAsDataUrl(blob);
    const current = entries();
    const entryIndex = current.findIndex((entry) => entry.id === messageId);
    if (entryIndex === -1) return;

    const attachments = current[entryIndex].attachments.map((item) =>
      attachmentKey(item) === key && !item.dataUrl ? { ...item, dataUrl, photoUnavailable: false } : item,
    );
    if (sameJSON(attachments, current[entryIndex].attachments)) return;

    const next = [...current];
    next[entryIndex] = { ...next[entryIndex], attachments };
    store[ARCHIVE_KEY] = next;
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
    if (!attachment.isImage || attachment.dataUrl) return;

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

function saveMessage(message) {
  if (store.captureEnabled === false) return;

  const incoming = toArchiveEntry(message);
  if (!incoming) return;

  const current = entries();
  const index = current.findIndex((entry) => entry.id === incoming.id);

  if (index === -1) {
    store[ARCHIVE_KEY] = [...current, { ...incoming, deleted: false, deletedAt: null }];
    cachePhotos(incoming.id, incoming.attachments);
    return;
  }

  const previous = current[index];
  const updated = {
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
    deleted: previous.deleted === true,
    deletedAt: previous.deletedAt || null,
  };

  if (sameJSON(previous, updated)) {
    cachePhotos(incoming.id, updated.attachments);
    return;
  }

  const next = [...current];
  next[index] = updated;
  store[ARCHIVE_KEY] = next;
  cachePhotos(incoming.id, updated.attachments);
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
    if (message?.id === messageId) return message;
  }

  return null;
}

function retainMessageInStore(message, id, channelId) {
  const messageId = asString(id || message?.id);
  const currentChannelId = asString(channelId || message?.channel_id || message?.channelId);
  const snapshot =
    message ||
    messageFromStore(messageId, currentChannelId) ||
    messageFromRenderedDom(messageId, currentChannelId);
  if (!snapshot?.id || !currentChannelId) return;

  setTimeout(() => {
    const retained = messageFromStore(messageId, currentChannelId);
    if (!retained) {
      try {
        fluxDispatcher?.dispatch?.({
          type: "MESSAGE_CREATE",
          channelId: currentChannelId,
          message: snapshot,
          alexandriaRetained: true,
        });
      } catch {
        // Blocking the original delete remains the primary retention path.
      }
    }
    markDeletedMessageAfterRender(messageId, currentChannelId);
  }, 0);
}

function markDeleted(id, channelId) {
  if (!id) return false;

  const messageId = asString(id);
  let current = entries();
  let index = current.findIndex((entry) => entry.id === messageId);

  // Messages sent before plugin startup do not have a MESSAGE_CREATE event for
  // Alexandria to observe. Recover them from Discord's store while the delete
  // action is still in flight, then archive them like any other message.
  if (index === -1) {
    const message =
      messageFromStore(messageId, asString(channelId)) ||
      messageFromRenderedDom(messageId, asString(channelId));
    if (message) {
      saveMessage({ ...message, channel_id: message.channel_id || channelId });
      current = entries();
      index = current.findIndex((entry) => entry.id === messageId);
    }
  }

  if (index === -1) return false;
  if (current[index].deleted) return true;

  const next = [...current];
  next[index] = {
    ...next[index],
    deleted: true,
    deletedAt: new Date().toISOString(),
  };
  store[ARCHIVE_KEY] = next;
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

  // Allow Alexandria's explicit cleanup action through to Discord's store.
  // Without this marker, the normal delete interceptor would retain it again.
  if (
    payload.alexandriaRemove &&
    (payload.type === "MESSAGE_DELETE" || payload.type === "MESSAGE_DELETE_BULK")
  ) return;

  if (payload.type === "MESSAGE_CREATE" || payload.type === "MESSAGE_UPDATE") {
    saveMessage(messageFromPayload(payload));
    return;
  }

  if (payload.type === "MESSAGE_DELETE") {
    const messageId = payload.id || payload.messageId || payload.message?.id;
    const channelId =
      payload.channel_id || payload.channelId || payload.message?.channel_id || payload.message?.channelId;
    const snapshot = messageFromStore(asString(messageId), asString(channelId)) || payload.message;

    try {
      markDeleted(messageId, channelId);
    } catch {
      // Archive enrichment is best-effort. It must never prevent the local
      // delete interceptor from preserving Discord's cached message.
    }
    // Shelter lets a Flux interceptor stop a dispatch by returning false. This
    // retains the message in Discord's in-memory store until a client restart,
    // mirroring MessageLogger's session-only behavior.
    // Retention must not depend on whether archive recovery succeeded. The
    // server has already deleted the message; blocking this dispatch only
    // preserves Discord's local cached copy for the current client session.
    retainMessageInStore(snapshot, messageId, channelId);
    return false;
  }

  if (payload.type === "MESSAGE_DELETE_BULK") {
    const ids = payload.ids || payload.messageIds || payload.messages;
    const channelId = payload.channel_id || payload.channelId;
    const snapshots = Array.isArray(ids)
      ? ids.map((id) => {
          const messageId = id?.id || id;
          return {
            id: messageId,
            message: messageFromStore(asString(messageId), asString(id?.channel_id || id?.channelId || channelId)),
          };
        })
      : [];
    if (Array.isArray(ids)) {
      try {
        ids.forEach((id) => markDeleted(id?.id || id, id?.channel_id || id?.channelId || channelId));
      } catch {
        // Keep bulk retention independent from archive enrichment too.
      }
    }
    snapshots.forEach(({ id, message }) => retainMessageInStore(message, id, channelId));
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
    if (row.querySelector(".alexandria-deleted-marker")) return;

    const marker = document.createElement("span");
    marker.className = "alexandria-deleted-marker";
    marker.textContent = " [Deleted]";
    marker.title = "This message was deleted and is being retained for this session.";
    (content?.closest('[data-list-item-id], li') === row ? content : row).append(marker);
  });
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

  const message = messageFromRenderedElement(element);
  // Do not mark the element until its fiber has yielded a message. React can
  // briefly render the element before the message props are attached.
  if (!message) return;
  saveMessage(message);
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
    '[id^="message-username-"], [id^="message-content-"], [id^="message-"]',
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
    saveMessage({
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
      fluxDispatcher?.dispatch?.({
        type: "MESSAGE_DELETE",
        channelId: entry.channelId,
        id: entry.id,
        alexandriaRemove: true,
      });
    } catch {
      // The archive copy can still be removed if Discord's local row already
      // disappeared or its internal store shape changed.
    }
  }

  const next = current.filter((entry) => entry.id !== messageId);
  if (next.length !== current.length) store[ARCHIVE_KEY] = next;
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

function ArchiveModal(props) {
  const [query, setQuery] = createSignal("");
  const [showAll, setShowAll] = createSignal(false);
  const [sortMode, setSortMode] = createSignal(store.sortMode || "deletedAt");
  const [selectedServer, setSelectedServer] = createSignal(store.serverFilter || "");
  const [selectedUser, setSelectedUser] = createSignal(store.userFilter || "");
  const [selectedDirectMessage, setSelectedDirectMessage] = createSignal(store.directMessageFilter || "");

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

  const visibleEntries = () => {
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

        const leftTime = Date.parse(left.deletedAt || left.timestamp) || 0;
        const rightTime = Date.parse(right.deletedAt || right.timestamp) || 0;
        return rightTime - leftTime;
      });
  };

  return (
    <ModalRoot size={ModalSizes.LARGE} class="alexandria-modal">
      <ModalHeader close={props.close}>Alexandria archive</ModalHeader>
      <ModalBody>
        <div class="alexandria-search">
          <TextBox
            value={query()}
            placeholder="Search messages, people, or channels"
            aria-label="Search the Alexandria archive"
            onInput={setQuery}
          />
        </div>
        <div class="alexandria-toolbar">
          <Button
            size={ButtonSizes.MIN}
            color={ButtonColors.SECONDARY}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll() ? "Deleted only" : "Show all captured"}
          </Button>
          <SearchablePicker
            id="alexandria-server-filter"
            value={selectedServer()}
            options={serverOptions}
            placeholder="Search servers"
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
            placeholder="Search users"
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
            placeholder="Search direct messages"
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
            <SelectOption value="deletedAt">Sort by deletion date</SelectOption>
            <SelectOption value="user">Sort by user</SelectOption>
            <SelectOption value="server">Sort by server name</SelectOption>
          </Select>
        </div>

        <div class="alexandria-summary">
          <span>{capturedCount()} message{capturedCount() === 1 ? "" : "s"} captured</span>
          <span>
            {showAll() ? "Showing all saved messages" : "Showing deleted messages only"}
            {selectedServer() && ` · ${serverOptions().find((server) => server.value === selectedServer())?.label || "Selected server"}`}
            {selectedUser() && ` · ${userOptions().find((user) => user.value === selectedUser())?.label || "Selected user"}`}
            {selectedDirectMessage() && ` · ${directMessageOptions().find((directMessage) => directMessage.value === selectedDirectMessage())?.label || "Selected direct message"}`}
          </span>
        </div>

        <Show
          when={visibleEntries().length > 0}
          fallback={
            <div class="alexandria-empty">
              {showAll() ? "No captured messages match your search." : "No deleted messages have been captured yet."}
            </div>
          }
        >
          <div class="alexandria-list">
            <For each={visibleEntries()}>
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
                    <time datetime={entry.timestamp}>{formatDate(entry.timestamp)}</time>
                    <Show when={entry.deletedAt}>
                      <time datetime={entry.deletedAt}>Removed {formatDate(entry.deletedAt)}</time>
                    </Show>
                    <span>{channelLabel(entry)}</span>
                  </div>
                  <div class="alexandria-entry-actions">
                    <button
                      class="alexandria-remove-entry"
                      type="button"
                      onClick={() => removeArchiveEntry(entry.id)}
                      aria-label={`Remove ${userLabel(entry)}'s message from the Alexandria archive`}
                    >
                      Remove message
                    </button>
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
                              when={attachment.dataUrl}
                              fallback={
                                <div class="alexandria-extra-item alexandria-photo-status">
                                  {attachment.photoUnavailable
                                    ? "Photo could not be saved locally."
                                    : "Saving photo locally…"}
                                </div>
                              }
                            >
                              <a
                                class="alexandria-photo"
                                href={attachment.dataUrl}
                                target="_blank"
                                rel="noreferrer"
                                title={attachment.filename}
                              >
                                <img src={attachment.dataUrl} alt={attachment.filename} />
                              </a>
                            </Show>
                          </Show>
                        )}
                      </For>
                    </div>
                  </Show>
                </article>
              )}
            </For>
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
    store[ARCHIVE_KEY] = [];
  } catch {
    // Closing or cancelling the confirmation leaves the archive untouched.
  }
}

function mountLauncher() {
  document.getElementById(launcherId)?.remove();
  launcherHost = document.createElement("div");
  launcherHost.id = launcherId;
  document.body.append(launcherHost);
  launcherHost.append(
    <ReactiveRoot>
      <Show when={store.showButton}>
        <button class="alexandria-launcher" onClick={openArchive} aria-label="Open Alexandria archive">
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
  const unobserve = scoped.observeDom(
    '[id^="message-username-"], [id^="message-content-"]',
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
  removeModal?.();
  removeModal = undefined;
  launcherHost?.remove();
  launcherHost = undefined;
}
