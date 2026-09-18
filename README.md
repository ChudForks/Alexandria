# Alexandria shelter plugin

Alexandria keeps a permanent, local archive of messages it captures before they
are deleted. Open the archive from the floating Alexandria launcher or the
plugin's settings. Closing the archive hides it without removing its contents.

Because Discord's delete event does not contain message text, Alexandria
captures messages before deletion through Flux, rendered message data, and
sent-message responses. It cannot recover messages from before the plugin was
enabled. The archive is stored in Shelter's persistent plugin storage and is
cleared only when you explicitly use **Clear archive**.

The recording scope can be set to every conversation or a chosen set of servers
and direct messages. The independent **Active mode** switch additionally records
the server or DM currently open in Discord, even when it is not selected, while
the configured servers and DMs continue recording.
The global **Capture messages** switch remains authoritative in every mode.

## Getting started
You should be using [pnpm](https://pnpm.io/) with this template ideally.

To install the dependencies and debug `hello-world` run:
```sh
pnpm i 
pnpm lune dev plugins/hello-world
```

Ensure that Lune Dev Mode is enabled in Discord so that lune can connect to it.

Now you can start debugging. The plugin will automatically reload after every change.

## Installing
To then install your finished plugin in shelter you can either rely on GitHub pages and it's workflow or you can build and host them here temporarily.

### Building locally
To build and host your plugins locally run:
```sh
pnpm lune ci
npx http-server dist/ --cors
```
Then you can install your plugin in shelter with this URL `http://localhost:8080/hello-world`.

### Publishing via GitHub
If you have published this repo on GitHub the plugins will be built after every commit.

For the GitHub action to run flawlessly, make sure you have the following setting enabled:
`Repo settings > Actions > General > Workflow permissions > Read and write permissions`

And for it to be hosted correctly you need to configure the `gh-pages` branch after its been created by the GitHub action. You can do this in `Repo settings > Pages > Branch`.

If this worked, you will be able to install the plugin via `https://<username>.github.io/<repo>/hello-world`.
