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

store[ARCHIVE_KEY] ??= [];
store.captureEnabled ??= true;
store.showButton ??= true;
store.sortMode ??= "deletedAt";

let launcherHost;
let removeModal;

const entries = () => (Array.isArray(store[ARCHIVE_KEY]) ? store[ARCHIVE_KEY] : []);
const fluxStores = shelter.flux?.storesFlat || {};

function asString(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value);
}

function normaliseAttachment(attachment) {
  return {
    filename: asString(attachment?.filename || attachment?.name, "Attachment"),
    url: asString(attachment?.url),
    contentType: asString(attachment?.content_type || attachment?.contentType),
  };
}

function normaliseEmbed(embed) {
  return {
    title: asString(embed?.title),
    description: asString(embed?.description),
    url: asString(embed?.url),
  };
}

function toArchiveEntry(message) {
  if (!message || !message.id) return null;

  const author = message.author || {};
  const channelId = asString(message.channel_id || message.channelId);
  const guildId = asString(message.guild_id || message.guildId);
  const channel = fluxStores.ChannelStore?.getChannel?.(channelId);
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
    guildName: asString(message.guild?.name || message.guild_name || message.guildName || guild?.name),
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

function saveMessage(message) {
  if (store.captureEnabled === false) return;

  const incoming = toArchiveEntry(message);
  if (!incoming) return;

  const current = entries();
  const index = current.findIndex((entry) => entry.id === incoming.id);

  if (index === -1) {
    store[ARCHIVE_KEY] = [...current, { ...incoming, deleted: false, deletedAt: null }];
    return;
  }

  const previous = current[index];
  const updated = {
    ...previous,
    ...incoming,
    // MESSAGE_UPDATE payloads are often partial. Preserve richer data already captured.
    content: incoming.content || previous.content,
    attachments: incoming.attachments.length ? incoming.attachments : previous.attachments,
    embeds: incoming.embeds.length ? incoming.embeds : previous.embeds,
    guildName: incoming.guildName || previous.guildName || "",
    deleted: previous.deleted === true,
    deletedAt: previous.deletedAt || null,
  };

  if (sameJSON(previous, updated)) return;

  const next = [...current];
  next[index] = updated;
  store[ARCHIVE_KEY] = next;
}

function markDeleted(id) {
  if (!id) return;

  const current = entries();
  const index = current.findIndex((entry) => entry.id === asString(id));
  if (index === -1 || current[index].deleted) return;

  const next = [...current];
  next[index] = {
    ...next[index],
    deleted: true,
    deletedAt: new Date().toISOString(),
  };
  store[ARCHIVE_KEY] = next;
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

  if (payload.type === "MESSAGE_CREATE" || payload.type === "MESSAGE_UPDATE") {
    saveMessage(messageFromPayload(payload));
    return;
  }

  if (payload.type === "MESSAGE_DELETE") {
    markDeleted(payload.id || payload.message?.id);
    return;
  }

  if (payload.type === "MESSAGE_DELETE_BULK") {
    const ids = payload.ids || payload.messageIds || payload.messages;
    if (Array.isArray(ids)) ids.forEach((id) => markDeleted(id?.id || id));
  }
}

function captureRenderedMessage(element) {
  if (!element || element.dataset.alexandriaCaptured) return;
  if (store.captureEnabled === false) return;

  try {
    const directProps = getProps(element);
    const directMessage =
      directProps?.message ||
      directProps?.children?.props?.message ||
      directProps?.data?.message;

    if (directMessage?.id) {
      saveMessage(directMessage);
      element.dataset.alexandriaCaptured = "1";
      return;
    }

    const fiber = reactFiberWalker(getFiber(element), "message", true);
    const message =
      fiber?.message ||
      fiber?.pendingProps?.message ||
      fiber?.memoizedProps?.message ||
      fiber?.stateNode?.props?.message;

    // Do not mark the element until its fiber has yielded a message. React can
    // briefly render the element before the message props are attached.
    if (!message) return;
    saveMessage(message);
    element.dataset.alexandriaCaptured = "1";
  } catch {
    // Discord's internal fiber shape can change between client updates.
  }
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

function archiveCount() {
  return entries().filter((entry) => entry.deleted).length;
}

function ArchiveModal(props) {
  const [query, setQuery] = createSignal("");
  const [showAll, setShowAll] = createSignal(false);
  const [sortMode, setSortMode] = createSignal(store.sortMode || "deletedAt");

  const visibleEntries = () => {
    const search = query().trim().toLowerCase();

    return entries()
      .filter((entry) => showAll() || entry.deleted)
      .filter((entry) => {
        if (!search) return true;
        return `${entry.author} ${entry.username} ${entry.content} ${entry.channelId}`
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
        <div class="alexandria-toolbar">
          <TextBox
            value={query()}
            placeholder="Search the archive"
            aria-label="Search the Alexandria archive"
            onInput={setQuery}
          />
          <Button
            size={ButtonSizes.MIN}
            color={ButtonColors.SECONDARY}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll() ? "Deleted only" : "Show all captured"}
          </Button>
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
            <SelectOption value="server">Sort by server</SelectOption>
          </Select>
        </div>

        <div class="alexandria-summary">
          {archiveCount()} deleted message{archiveCount() === 1 ? "" : "s"} saved locally
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
                    <span class="alexandria-author">{entry.author}</span>
                    <span class="alexandria-status">{entry.deleted ? "Deleted" : "Captured"}</span>
                  </div>
                  <div class="alexandria-meta">
                    <time datetime={entry.timestamp}>Sent {formatDate(entry.timestamp)}</time>
                    <Show when={entry.deletedAt}>
                      <time datetime={entry.deletedAt}>Deleted {formatDate(entry.deletedAt)}</time>
                    </Show>
                    <Show when={entry.channelId}>
                      <span>Channel {entry.channelId}</span>
                    </Show>
                    <span>{serverLabel(entry)}</span>
                  </div>
                  <Show when={entry.content}>
                    <p class="alexandria-content">{entry.content}</p>
                  </Show>
                  <Show when={entry.embeds?.length}>
                    <div class="alexandria-extra">
                      <For each={entry.embeds}>
                        {(embed) => (
                          <div>
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
                        {(attachment) => <div>Attachment: {attachment.filename}</div>}
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
          <span class="alexandria-launcher-icon" aria-hidden="true">✦</span>
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
