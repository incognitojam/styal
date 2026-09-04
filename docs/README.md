# T3 Code docs

## Using T3 Code

- [How styal differs from T3 Code](./user/styal-differences.md)
- [Install and first run](./user/install.md)
- [Permission modes](./user/permission-modes.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Run commands in the terminal](./user/terminal.md)
- [Project scripts and environment variables](./user/project-scripts.md)
- [Reading the chat timeline](./user/chat-timeline.md)
- [How diffs order their files](./user/diff-file-order.md)
- [Organizing threads](./user/thread-sidebar.md)
- [Discord Rich Presence](./user/discord-rich-presence.md)
- [Review usage](./user/usage.md)
- [Anonymous usage data](./user/telemetry.md)
- [Project icons and workspace ports](./user/project-settings.md)
- [Import T3 Code data](./user/importing-t3-code-data.md)
- [Mobile appearance](./user/mobile-appearance.md)
- [Environment themes](./user/environment-theme.md)
- [Remote access](./user/remote-access.md)
- [Keeping app and server in sync](./user/updating.md)
- [Source control integrations](./user/source-control.md)
- [Background service (Linux)](./user/background-service.md)
- Providers: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [OpenCode](./user/providers-opencode.md)

Mobile app: [apps/mobile/README.md](../apps/mobile/README.md)

---

## Working on T3 Code

Start with the [development runbook](./operations/development.md) and
[contribution policy](../CONTRIBUTING.md).

Internal notes preserve architectural decisions, constraints, and implementation traps that the
source alone does not explain. Most code changes do not need an internal documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding one.

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Fork feature ledger](./internals/fork-feature-ledger.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Model classification](./internals/model-manifest.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Product analytics](./internals/product-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [T3 Connect](./internals/t3-connect.md) (upstream mechanics)
- [styal Link](./internals/styal-link.md) (fork deployment and Clerk setup)
- [Assistant citations](./internals/assistant-citations.md)
- [Mobile navigation](./internals/mobile-navigation.md)
- [Mobile development lifecycle](./internals/mobile-development.md)
- [Terminal runtime](./internals/terminal-runtime.md)
- [Voice input](./internals/voice-input.md)

### Runbooks

- [Development and local builds](./operations/development.md)
- [T3 Connect setup](./operations/connect-setup.md)
- [Release](./operations/release.md)
- [Fork nightly releases](./operations/fork-nightly.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
