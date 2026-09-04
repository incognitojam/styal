# Install styal

styal runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

styal supports Apple Silicon macOS, Linux x64 and arm64 (glibc), and Windows x64
and arm64. Intel macOS is unsupported. The desktop app, the standalone installer,
and release archives include their own server runtime, so they need neither Node.js
nor a compiler, although provider CLIs may need Node.js. Running through npm needs
Node.js and npm for the launcher.

You need an installed, authenticated provider before starting a thread. You can
launch styal and configure providers afterwards.

## Install the CLI

On macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/incognitojam/styal/main/scripts/install.sh | STYAL_CHANNEL=nightly sh
```

On Windows, in PowerShell:

```powershell
$env:STYAL_CHANNEL = "nightly"
irm https://raw.githubusercontent.com/incognitojam/styal/main/scripts/install.ps1 | iex
```

The installer verifies the release checksum and adds a `styal` launcher under
`~/.local/bin`. Follow its PATH instructions if that directory is not on your PATH.
Set `STYAL_VERSION` to install an exact version, or `STYAL_CHANNEL=stable` for
stable releases.

Run `styal start` to start the server and open the local web app, or `styal serve`
for a headless server. Running `styal` without a subcommand shows its help. Run
`styal update` to install a newer version and choose whether to restart an
installed background service. `styal uninstall` removes the managed runtime and
service while keeping projects, threads, and settings.

## Run with npm

```bash
npx @styal/cli@nightly start
```

This starts the server and opens the local web app. Run
`npx @styal/cli@nightly --help` for command-line options.

For a persistent installation, run `npm install -g @styal/cli@nightly`. The
installed command is `styal`. The package installs a matching prebuilt
executable, so it needs no native compilation or install-script approval. Use
`@latest` instead of `@nightly` for stable releases once one is available.

## Standalone archive

Download the `styal-<version>-<platform>-<arch>` archive for your machine from
[GitHub Releases](https://github.com/incognitojam/styal/releases), with its
`SHA256SUMS` file. Extract the whole archive and run `./styal serve`
(`styal.exe serve` on Windows) from the extracted directory. Keep the executable
with its accompanying folders; copying the executable alone does not work.

## Desktop app

Download a styal installer from
[GitHub Releases](https://github.com/incognitojam/styal/releases).

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install provider CLIs inside that distro. styal installs its matching
server runtime there automatically, so the distro needs neither Node.js nor a
compiler to run styal, although provider CLIs may need Node.js. The first launch
after an app update can take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
styal app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `styal app ../my-project`, to open another directory. It
requires the desktop app, so a standalone server or an SSH session is not enough.
If the command cannot reach the app, start or update the desktop app and try
again.

## Mobile app

The styal mobile app is a work in progress. The phone connects to a server on
another machine. Follow [remote access](./remote-access.md) to link it through
styal Link or a pairing URL.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.        |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`. |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                        |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                           |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                     |
| Antigravity | Install and sign in with Google from styal's provider settings.                              |

Provider CLIs must be on the server's `PATH`. If styal cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Antigravity can use its managed runtime without a `PATH` entry.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, styal does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating styal](./updating.md): update the app and connected servers.
