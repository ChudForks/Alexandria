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
store.serverFilter ??= "";
store.userFilter ??= "";

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

function markDeleted(id, channelId) {
  if (!id) return;

  const messageId = asString(id);
  let current = entries();
  let index = current.findIndex((entry) => entry.id === messageId);

  // Messages sent before plugin startup do not have a MESSAGE_CREATE event for
  // Alexandria to observe. Recover them from Discord's store while the delete
  // action is still in flight, then archive them like any other message.
  if (index === -1) {
    const message = messageFromStore(messageId, asString(channelId));
    if (message) {
      saveMessage({ ...message, channel_id: message.channel_id || channelId });
      current = entries();
      index = current.findIndex((entry) => entry.id === messageId);
    }
  }

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
    markDeleted(payload.id || payload.message?.id, payload.channel_id || payload.channelId || payload.message?.channel_id);
    return;
  }

  if (payload.type === "MESSAGE_DELETE_BULK") {
    const ids = payload.ids || payload.messageIds || payload.messages;
    const channelId = payload.channel_id || payload.channelId;
    if (Array.isArray(ids)) ids.forEach((id) => markDeleted(id?.id || id, id?.channel_id || channelId));
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

function serverKey(entry) {
  return entry.guildId || "@direct-messages";
}

function userKey(entry) {
  return entry.authorId || `@${entry.username || entry.author}`;
}

function userLabel(entry) {
  return entry.username && entry.username !== entry.author ? `${entry.author} (@${entry.username})` : entry.author;
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

  const visibleEntries = () => {
    const search = query().trim().toLowerCase();

    return entries()
      .filter((entry) => showAll() || entry.deleted)
      .filter((entry) => !selectedServer() || serverKey(entry) === selectedServer())
      .filter((entry) => !selectedUser() || userKey(entry) === selectedUser())
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
                    <span>{serverLabel(entry)}</span>
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
                        {(attachment) => <div class="alexandria-extra-item">↗ {attachment.filename}</div>}
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
