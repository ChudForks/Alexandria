# Alexandria

Alexandria is a Shelter plugin that preserves messages locally before they are deleted. It stores a searchable, rolling archive in Shelter's plugin storage without retaining deleted messages in Discord's live memory.

## Features

- Preserves deleted messages and their locally cached photos in a rolling archive (up to 2,000 entries / 250 MB)
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

Current version: **0.7.1**
