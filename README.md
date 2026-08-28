# styal

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/brand/wordmark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./assets/brand/wordmark-light.svg">
    <img alt="styal" src="./assets/brand/wordmark-light.svg" width="320">
  </picture>
</p>

styal is an open-source control plane for coding agents. It lets you run and direct provider CLIs such as Claude Code, Codex, Cursor, Grok Build, and OpenCode from desktop and web clients.

> [!IMPORTANT]
> styal is early in its transition to an independent product and is not yet offered as a supported public release. Hosted web and remote infrastructure, repeatable nightly and release builds, and production deployment are still being brought online. A styal mobile release will come later.

## About this fork

styal began as a fork of [T3 Code](https://github.com/pingdotgg/t3code), created by the team at [Ping](https://ping.gg). It continues to track `pingdotgg/t3code` as upstream while developing its own branding, product direction, design language, and user interface.

The fork already carries behavior beyond upstream. See the rolling [styal features and improvements](https://github.com/incognitojam/styal/issues/43) summary for the user-facing differences, or the maintainer-facing [fork feature ledger](./.github/fork-features.yml) for the capabilities and tests preserved during upstream rebases.

The transition is intentionally gradual. Inherited package names, source paths, documentation, and application copy will continue to reference T3 Code until the corresponding styal surface is ready to own.

## Current direction

- Establish styal's public identity and design language.
- Deploy the hosted web app and remote connectivity on styal-owned infrastructure.
- Produce dependable desktop nightlies and releases in CI.
- Bring the mobile client to styal after the desktop and web foundations are ready.
- Keep incorporating useful upstream work without losing styal-specific behavior.

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
