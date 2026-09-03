# Install styal

styal is a web and desktop GUI for running coding agents on your machine.

## Requirements

Supported platforms are Apple Silicon macOS, Linux x64/arm64 (glibc), and Windows
x64/arm64. Intel macOS is unsupported. styal includes its own server runtime and
native dependencies. Installing through npm needs Node and npm to run the launcher;
the standalone installer needs neither Node nor a compiler.

At least one provider runtime, installed and authenticated. You can install Antigravity from
T3 Code settings. See [Providers](#providers) below.

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
Set `STYAL_VERSION` to install an exact version, or `STYAL_CHANNEL=stable` for stable
releases. Run `styal update` to install a newer version and choose whether to restart
an installed background service. `styal uninstall` removes the managed runtime and
service while keeping projects, threads, and settings.

## Run with npm

```bash
npx @styal/cli@nightly start
```

This starts the styal server on your machine and opens the local web app. Running the CLI without a
subcommand shows its help instead. Use `npx @styal/cli@nightly --help` for the full CLI reference.

For a persistent CLI installation:

```sh
npm install -g @styal/cli@nightly
styal --help
```

The npm package installs the matching prebuilt executable; native compilation and
install-script approvals are unnecessary. The package is `@styal/cli`; the installed command is `styal`. Nightly releases use
`@nightly`. Use `@latest` for stable releases once one is available.

## Standalone archive

Download the `styal-<version>-<platform>-<arch>` archive for your machine from
[GitHub Releases](https://github.com/incognitojam/styal/releases), alongside its
`SHA256SUMS` file. Extract the whole archive and run `./styal serve` (`styal.exe serve`
on Windows) from the extracted directory. Keep the executable with its accompanying
folders; copying the executable alone is insufficient.

Archives support Apple Silicon Macs, Linux x64 and arm64, and Windows x64 and arm64.
Intel Macs are unsupported. The server needs neither a separate Node installation
nor a compiler. Your provider CLIs may still require Node.

## Open a project in the desktop app

When the styal desktop app is running on the same machine, open the current directory with:

```bash
styal app
```

Pass a path to open another directory:

```bash
styal app ../my-project
```

The command adds the directory as a project when needed, focuses the desktop app, and opens a new
thread. It does not launch the desktop app, open a browser, or start a styal server. A background
server does not count as the desktop app. The command also rejects SSH sessions because a remote
shell cannot focus a local desktop window. The CLI package and the running desktop app must both
include `styal app` support.

## Desktop App

Download a styal installer from [GitHub Releases](https://github.com/incognitojam/styal/releases).

Windows packages include the Linux CLI used by the WSL backend. On first use, styal
verifies and caches it inside your distro. Later launches reuse that cache. WSL
needs neither Node nor a compiler to run styal, although your provider CLIs may need
Node. A healthy new runtime replaces older caches while retaining the previous one.

## Providers

styal uses provider runtimes but does not bundle them. Install and authenticate each
provider's CLI, or use styal's managed setup for Antigravity.

| Provider    | CLI                                                                                                        | Default binary     | Log in with                        |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------- |
| Codex       | [Codex CLI](https://developers.openai.com/codex/cli)                                                       | `codex`            | `codex login`                      |
| Claude      | [Claude Code](https://claude.com/product/claude-code)                                                      | `claude`           | `claude auth login`                |
| Cursor      | [Cursor CLI](https://cursor.com/cli)                                                                       | `cursor-agent`     | `agent login`                      |
| Grok Build  | [Grok Build CLI](https://x.ai/cli)                                                                         | `grok`             | `grok login`                       |
| OpenCode    | [OpenCode](https://opencode.ai)                                                                            | `opencode`         | `opencode auth login`              |
| Antigravity | [Official ACP agent](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json) | Managed by T3 Code | **Sign in with Google** in T3 Code |

Codex and Claude are on by default. Cursor, Grok Build, OpenCode, and Antigravity are off by
default. Turn them on in **Settings** > **Providers** when you want to use them.

For Antigravity, select the environment in provider settings, then install and sign in there.
The runtime and credentials stay on that environment, even when you use a phone or remote
browser. See [Antigravity setup](./providers-antigravity.md) for Google sign-in, remote callback
steps, and supported hosts.

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
styal looks for, but authenticate with `agent login`, not `cursor-agent login`.

Grok models that support adjustable reasoning show a **Reasoning** control beside the model picker.
The available levels and default come from the installed Grok Build CLI, so they can vary by model
and CLI version.

Run CLI login commands on the machine running the styal server, not on the device you browse
from. Antigravity uses its sign-in controls in styal instead of a CLI login command.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started styal.

Antigravity can use its managed runtime without a `PATH` entry. Its optional **Binary path**
overrides the managed runtime and must point to the official ACP executable.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
styal. You can install styal, open it, and add providers afterwards. A provider that is not
authenticated shows its status and setup instructions in **Settings**.

For multi-account setups, see [Codex](./providers-codex.md), [Claude](./providers-claude.md), and
[Antigravity](./providers-antigravity.md#accounts-and-removal).

## Next Steps

- [Permission modes](./permission-modes.md): how much styal asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping styal in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
