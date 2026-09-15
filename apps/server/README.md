# styal CLI

Run the styal server and bundled web client for coding agents.

```sh
npx @styal/cli@nightly
```

For a persistent installation:

```sh
npm install -g @styal/cli@nightly
styal --help
```

Use `@latest` for stable releases once one is available. Install and authenticate your provider CLIs on the server machine separately.

## Headless hosts

```sh
styal serve --no-browser
```

On Linux with systemd, or macOS with launchd, install a background service:

```sh
styal service install
styal service status
```

To install a specific version and update an existing styal service, run `npx @styal/cli@<version> service update` on the host. This replaces older styal launchers that installed the upstream `t3` package. Existing styal data is retained. Let active agent work finish before restarting the service.

Containers without a service manager should run `styal serve --no-browser` under their container's process supervisor.

Source and releases: [incognitojam/styal](https://github.com/incognitojam/styal).

## npm 12 and native dependencies

npm 12 requires permission to run native dependency install scripts. When using
npm 12 or newer, install with:

```sh
npm install -g @styal/cli@nightly --allow-scripts=node-pty --allow-scripts=msgpackr-extract
```

Then run `styal`. The background-service updater supplies these flags automatically.
