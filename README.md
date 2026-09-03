# styal

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/brand/wordmark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./assets/brand/wordmark-light.svg">
    <img alt="styal" src="./assets/brand/wordmark-light.svg" width="320">
  </picture>
</p>

styal is an open-source control plane for coding agents. It lets you run and direct provider CLIs such as Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity from desktop and web clients.

> [!IMPORTANT]
> styal is in active development. The hosted web app at [app.styal.build](https://app.styal.build) is live, with rough edges and incomplete functionality. Importing T3 Code projects and preferences works. The mobile app is a work in progress.

## About this fork

styal began as a fork of [T3 Code](https://github.com/pingdotgg/t3code), created by the team at [Ping](https://ping.gg). It continues to track `pingdotgg/t3code` as upstream while developing its own branding, product direction, design language, and user interface.

See [How styal differs from T3 Code](./docs/user/styal-differences.md) for an overview of its workspace, agent, and review features. The maintainer-facing [fork feature ledger](./.github/fork-features.yml) records the capabilities and tests preserved during upstream integration.

The transition is intentionally gradual. Inherited package names, source paths, documentation, and application copy will continue to reference T3 Code until the corresponding styal surface is ready to own.

> [!WARNING]
> styal currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

## Development

Development currently requires Node.js 22.16+, 23.11+, or 24.10+ and [Vite+](https://viteplus.dev/guide/).

Install Vite+ on macOS or Linux:

```bash
curl -fsSL https://vite.plus | bash
```

Or on Windows:

```powershell
irm https://vite.plus/ps1 | iex
```

Then install dependencies and start the local server and web client:

```bash
vp i
vp run dev
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a pull request.

## Documentation

Documentation lives in [docs/](./docs). Start with the [architecture overview](./docs/internals/overview.md) when working on the repository. Some inherited documentation still describes T3 Code while the styal equivalents are being established.

## License

styal retains the upstream project's [MIT license](./LICENSE).
