# Message logging research

Reviewed October 22, 2026. These notes describe the current implementation and primary sources; the checklist below still requires verification in a running Discord client.

## Shelter integration

Shelter favors Flux, React Fiber, browser APIs, and plugin-owned UI over webpack source patches. Alexandria follows that model with Flux interception, guarded store/fiber lookups, DOM observation, Solid components, and IndexedDB media. See [Shelter's stability principles](https://shelter.uwu.network/guides/ideals).

The [Shelter API reference](https://shelter.uwu.network/reference) establishes these integration rules:

- `plugin.scoped` automatically disposes registered interceptors, observers, and CSS. Register ordinary timers, event listeners, and other resources with `onDispose`.
- `flux.awaitStore` handles stores that are unavailable at startup; store methods themselves remain Discord implementation details.
- Await `http.ready` before making requests. An HTTP interceptor must call `send` at most once and return the response; local archival errors must not turn a successful send into a rejected promise.
- Assign a top-level store property when persisting archive changes. Deep mutations need `plugin.flushStore()`.
- `observeDom(...).now()` stops observation immediately; it does not scan the existing document. An explicit startup scan is necessary.

**Architectural limitation, inferred from the implementations:** returning `false` from Shelter's Flux interceptor suppresses a deletion for all subscribers, whereas Vencord patches selected message-store handlers. Retaining live deleted rows may therefore suppress other Discord cleanup too. Keep retention bounded, pass unknown/excluded IDs through normally, and verify unread indicators and navigation manually. This follows from the API reference and [Vencord's store patches](https://github.com/Vendicated/Vencord/blob/main/src/plugins/messageLogger/index.tsx); it is not a guarantee about Discord's current internal stores.

## Discord event and media behavior

- [Discord's delete events](https://docs.discord.com/developers/events/gateway-events#message-delete) provide message/channel identifiers, and bulk deletion provides an ID array. Original text and media must already have been captured. Missed events while Discord is closed cannot be reconstructed from these events.
- Merge partial updates as patches: an omitted `content` or `attachments` field must preserve its prior value; explicit `""` and `[]` clear the current value. The [discord.js message implementation](https://github.com/discordjs/discord.js/blob/main/packages/discord.js/src/structures/Message.js) similarly checks field presence before replacing cached values. This is primary implementation evidence for defensive merging, not a promise about Discord's internal Flux payload shape. [Discord's Gateway reference](https://docs.discord.com/developers/events/gateway-events#message-update) documents the public event.
- [`EPHEMERAL` is flag `1 << 6`](https://docs.discord.com/developers/resources/message#message-object-message-flags). Alexandria excludes these interaction responses. The message schema also exposes `edited_timestamp`; content changes and attachment removals should produce history, while unrelated embed updates should not create duplicate text revisions.
- [Attachment CDN URLs expire](https://docs.discord.com/developers/reference#signed-attachment-cdn-urls). Preserve valid signatures and save blobs while available; changing URL parameters does not provide a general recovery mechanism for expired or deleted media.
- [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits) can change. Use Discord's HTTP layer and honor `retry_after`; a fixed request interval alone is not a rate-limit guarantee. Experimental preloading remains opt-in and limited to selected sources.

## Vencord comparison

Comparison uses the current [MessageLogger source](https://github.com/Vendicated/Vencord/blob/main/src/plugins/messageLogger/index.tsx) and [history modal](https://github.com/Vendicated/Vencord/blob/main/src/plugins/messageLogger/HistoryModal.tsx).

| Capability | Vencord MessageLogger | Alexandria |
| --- | --- | --- |
| Deleted messages | Temporary chat retention | Bounded live retention and persistent searchable archive |
| Edited text | Inline history and history modal | Persistent archive revisions; latest 25 within 128 KB per message |
| Removed attachments | Retained in message rendering | Archive metadata and locally cached photos; latest 50 removals |
| Exclusions | Bots, self, users, channels, guilds | Same categories; exact ID lists, including parent-channel exclusions |
| Bot default | Ignored | Included for compatibility with existing Alexandria settings |
| Deleted appearance | Red text or overlay; optional collapsing | Red text; overlay/collapse remain future work |
| History cleanup | Message and channel actions | Per-entry archive removal and full archive clear |
| Media persistence | No separate persistent photo archive | Bounded IndexedDB photo cache and clipboard preview |

Alexandria does not currently provide Vencord's inline revision rendering, clickable native edited marker, or Discord markdown parser integration. Implementing those through source patches would increase coupling to Discord internals; archive UI remains the supported history surface.

## Manual live verification

Use a test conversation and messages you control. Offline tests cannot establish current Discord DOM, store, and renderer compatibility.

- [ ] Edit a loaded message twice, including changing text to empty. Confirm ordered prior versions, latest text, searchable old text, and no duplicate revision after scrolling or reopening the channel.
- [ ] Remove a photo through an edit, then add another photo and delete the message. Confirm removal labels, cached originals, enlarged preview/copy, and preservation after restart. Repeat with edit logging and attachment preservation individually disabled.
- [ ] Send and immediately delete a message; repeat from another device while desktop Discord is elsewhere. Confirm capture only when an original snapshot and deletion event were observed.
- [ ] Bulk-delete mixed captured, uncaptured, and excluded messages. Confirm only captured messages are retained and ordinary deletion continues for the remainder.
- [ ] Check Selected and All scopes, active-server/DM capture, bot/self exclusions, and exact user/channel/guild IDs. Confirm exclusions override active capture and ephemeral responses are absent.
- [ ] Navigate between servers, DMs, and threads after deletion. Check red rows, unread indicators, reply previews, and normal message actions.
- [ ] Disable/unload during photo downloads and a history request. Confirm retained rows and injected UI clean up, no late capture occurs, and normal sending/deletion continues after reload.
- [ ] Clear the archive with history enabled. Confirm saved entries/photos disappear and a late response cannot refill it immediately.
