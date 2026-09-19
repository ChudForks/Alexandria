# Alexandria

Alexandria is a Shelter plugin that preserves messages locally before they are deleted. It keeps a small, session-only buffer of visible messages, then commits only deleted messages to a searchable rolling archive. Deleted messages remain red in chat briefly, then Discord releases their live memory.

## Features

- Preserves deleted messages and their locally cached photos in a rolling archive (up to 2,000 entries / 250 MB)
- Keeps only the latest 250 visible messages (up to 16 MB) in session memory until they are deleted; ordinary messages are not persistently archived
- Shows deleted messages red in chat for 30 seconds (up to 100 at a time), then releases them automatically
- Searchable archive with server, direct-message, and user filters
- Configurable capture scopes for servers and direct messages
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

## Usage

Click the Alexandria launcher to open the archive. Drag the launcher to move it anywhere inside the Discord window. Its position is saved automatically.

Use the plugin settings to choose which servers or direct messages Alexandria records, enable active-conversation capture, backfill archived photos, or clear the archive.

Discord's delete event does not include the original message contents, so Alexandria must see a message before it is deleted. It cannot recover messages deleted before the plugin was enabled.

## Privacy and storage

The archive is stored locally in Shelter's persistent plugin storage. To keep Discord responsive in busy servers, Alexandria retains the newest entries that fit within 2,000 messages and 250 MB; older entries are removed automatically. Cached photos can consume substantially more space than text messages.

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

Current version: **0.7.3**
