# Alexandria

Alexandria is a Shelter plugin that preserves deleted messages, previous text versions and attachments removed by edits in a searchable local archive. Ordinary messages stay in a small session-only buffer until an observed edit or deletion needs archiving. An optional experimental mode also retains undeleted history locally. Deleted messages remain red in chat until Discord restarts, subject to bounded session-memory limits.

## Features

- Preserves deleted and edited messages and their locally cached photos in a rolling archive (up to 2,000 entries / 16 MB of metadata / 2 GB including photos)
- Keeps the latest 25 previous text versions within 128 KB per message, with timestamps and an expandable history
- Preserves the newest 50 attachments removed by edits per message, including already cached photos
- Stores archived photos as disk-backed IndexedDB blobs and loads them only near the visible archive viewport
- Keeps the latest 250 ordinary visible messages (up to 16 MB) in session memory; unedited, undeleted messages are not persistently saved by default
- Pre-caches visible photos in a bounded 300 MB disk staging area so older signed Discord URLs are captured before deletion
- Limits the photo queue to 512 jobs and three active downloads, with a 20-second download timeout and cancellation on eviction or unload
- Shows deleted messages red until restart, retaining at most 250 rows / an estimated 300 MB at once
- Replaces retained live media with bounded static previews so Discord can release full-size and animated media memory; originals remain available in the archive
- Searchable archive with Deleted, Edited and All archived views, plus server, direct-message and user filters; search also finds previous text, filenames and message/user IDs
- Configurable capture scopes for servers and direct messages
- Optional bot/self exclusions and exact user, channel, category or server ID exclusions; channel exclusions include child threads
- Ephemeral interaction responses are excluded from capture
- Optional experimental older-message capture: retains seen history across restarts and preloads recent history from explicitly selected sources
- Vencord MessageLogger-style deleted-message appearance
- Enlarged archived-photo preview with clipboard copying
- Movable launcher that remembers its position
- Local storage with no external archive service

## Install

1. Install [Shelter](https://shelter.uwu.network/).
2. Open Discord's **Settings**.
3. Go to **Shelter → Plugins** and select **Add Plugin**.
4. Paste this URL:

   ```text
   https://chudforks.github.io/Alexandria/alexandria/
   ```

5. Enable **Alexandria**.

Shelter can check the same URL for future updates.

To switch from development mode, disable **Lune Dev Mode** in Shelter's developer options, then add the hosted plugin using the URL above. The hosted plugin runs without the local development server.

## Usage

Click the Alexandria launcher to open the archive. Drag the launcher to move it anywhere inside the Discord window. Its position is saved automatically.

Use the plugin settings to choose which servers or direct messages Alexandria records, enable active-conversation capture, backfill archived photos, or clear the archive.

**Log message edits** and **Preserve removed attachments** are enabled by default. These save observed changes even before the message is deleted. Open the **Edited** view and expand a message's previous versions to inspect them. Turning either setting off stops capturing new history of that kind; existing archived history stays until removed or cleared. Metadata-only updates and refreshed photo URLs do not create text revisions.

Capture exclusions apply before All, Selected or Active scope. Paste user, channel/category or server IDs separated by commas or whitespace into settings. Bot and self exclusions are off by default. Exclusions stop new capture and deleted-row retention; they do not erase older archived entries.

Discord's delete event does not include the original message contents, so Alexandria must see a message before it is deleted. It cannot recover messages deleted before the plugin was enabled.

### Experimental older-message capture

This toggle is **off by default**. Enable it to keep text and attachment metadata from loaded history and messages Alexandria sees. To preload without opening each conversation, choose **Selected servers and direct messages**, then check the sources you want. Preloading is restricted to those selections, not every server in All scope or unselected active conversations.

The preloader fetches at most the latest 100 messages in each locally known, readable text/thread channel or selected DM. It processes up to 20 channels per batch, one request at a time with at least a second between requests, then pauses five minutes. Larger selections rotate between batches. Rate-limit responses pause it longer when necessary. It does not crawl full histories, download every background photo, or mark conversations as read.

Snapshots enter the main archive when Alexandria observes a deletion, a logged edit or a removed attachment. This can improve phone-deletion coverage while the desktop is elsewhere, but only after the relevant original has been cached. Messages outside the recent pages must first be loaded normally, and missed delete events while Discord is closed cannot be reconstructed. Older photos may no longer be available.

## Privacy and storage

Archive metadata is stored in Shelter's persistent plugin storage, while photos are stored separately as IndexedDB blobs and loaded only when viewed. To keep Discord responsive in busy servers, Alexandria retains the newest entries that fit within 2,000 messages, approximately 16 MB of text/metadata and 2 GB including photos; older entries and their photo blobs are removed automatically. This includes edit history and removed attachments. Live deleted rows use a separate 250-message / estimated 300 MB session cap, including encoded attachment sizes and decoded image surfaces when Discord supplies dimensions.

Experimental history uses a separate IndexedDB store and an in-memory lookup, capped at 2,000 snapshots or approximately 16 MB of text/metadata, expiring seven days after last capture. This means **undeleted message text is saved locally too**, and preloading adds Discord requests, memory use and disk writes. No history is uploaded to an external archive service. Turning the toggle off or confirming **Clear archive** purges the extra history cache; disabling the plugin alone retains it for the next enabled session. Clear archive also discards late history responses and delays the next background batch for five minutes. The ordinary session buffer is still separate.

## Development

Install dependencies and start Lune development mode:

```sh
pnpm install
pnpm lune dev plugins/alexandria
```

Build the plugin:

```sh
pnpm lune ci
```

Run the offline regression tests (no live Discord connection required):

```sh
pnpm test
```

Research sources, implementation tradeoffs and live Discord checks: [message logging notes](docs/message-logging-research.md).

## Publishing

Pushing to `main` runs the regression tests, builds the plugin and its website, and deploys `dist/` to GitHub Pages. The **Build and deploy** workflow can also be run manually from GitHub Actions.

- Website: <https://chudforks.github.io/Alexandria/>
- Shelter install URL: <https://chudforks.github.io/Alexandria/alexandria/>

Current version: **0.9.0**
