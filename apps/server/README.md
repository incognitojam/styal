# styal CLI

Run the styal server and bundled web client for coding agents.

Supports Apple Silicon macOS, Linux x64/arm64 (glibc), and Windows x64/arm64. Intel
macOS is unsupported. npm installs a launcher and the matching prebuilt executable;
it does not compile native dependencies. Standalone archives include the same runtime.

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

To install a specific version and update an existing styal service, run `npx @styal/cli@<version> service update` on the host. This migrates older npm-based styal service launchers to executable archives. Existing styal data is retained. Let active agent work finish before restarting the service.

Containers without a service manager should run `styal serve --no-browser` under their container's process supervisor.

Source and releases: [incognitojam/styal](https://github.com/incognitojam/styal).

Update an installed runtime with `styal update`. Remove managed runtimes and the
background service with `styal uninstall`; projects, threads, and settings are kept.
For an npm installation, remove its launcher with `npm uninstall -g @styal/cli`.
