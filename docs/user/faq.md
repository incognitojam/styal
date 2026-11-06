# FAQ

## Is styal a harness?

No. A harness is what turns an LLM into an agent: it gives the model tools, a way to call them, runs them, and hands the results back. Claude Code is an interface (the TUI, the Code tab in the desktop app) plus a harness underneath (the Anthropic Agent SDK). Codex is the same split: the app plus the Codex App Server. styal uses those harnesses. It is not a harness, and it does not work without one.

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Pi, or Muse Code. [Provider setup](./install.md#providers)

## How is styal related to T3 Code?

styal began as a fork of [T3 Code](https://github.com/pingdotgg/t3code) and keeps tracking it, while adding its own workspace, agent, and review features. It has its own releases, its own styal Link relay, and its own product usage data. [How styal differs from T3 Code](./styal-differences.md)

## Can I use styal with my Claude Code subscription?

Yes.

## How much does styal cost?

Nothing. styal is free and open source (MIT). You bring your own subscription and still pay your provider like you already do. [Install](./install.md)

## How do I use styal remotely?

Your agents run wherever styal runs: your desktop, a server, a VPS. You connect to it from anywhere. Run `npx @styal/cli@nightly link` on that machine to make it reachable through styal Link. LAN pairing and Tailscale work too, and [app.styal.build](https://app.styal.build) is the web client. [Remote access](./remote-access.md)

## How do I use styal on my phone?

The mobile app is a work in progress. On Android, install the newest **styal for Android** APK from the [releases page](https://github.com/incognitojam/styal/releases). On iPhone and iPad, TestFlight is invite-only. Connect the app to your computer with styal Link or a pairing link. The phone is a remote. Your computer does the work and needs to stay on. [Mobile setup](./install.md#mobile-app) · [Remote access](./remote-access.md)

## Why does styal Link keep disconnecting?

styal Link is the built-in alternative to Tailscale for remote connections. If it keeps dropping, open **Settings > Environments**, find the machine, and select **Details**. The first part marked as failed is the cause. Tailscale works well as a fallback. [styal Link troubleshooting](./t3-connect-troubleshooting.md)

## Can I add a bunch of accounts for one provider?

A separate work account is fine. Setup for two: [Codex](./providers-codex.md#use-multiple-accounts) · [Claude](./providers-claude.md#separate-accounts-or-configurations). styal does not switch between accounts for you. For a bigger pool, manage them outside styal with a self-hosted proxy like [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), and check that your provider's terms allow it. After you set up a hub, styal can show its pooled limits under Usage. [Connect a hub](./usage.md#connect-a-cliproxyapi-hub)

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in Settings and give it its own keys and endpoint. Claude has a full OpenRouter recipe. Your subscription setup stays untouched. [OpenRouter](./providers-claude.md#openrouter) · [Provider instances](./install.md#providers)

## Does my code go to styal servers?

No. Your code and prompts go from your machine to your provider (Anthropic, OpenAI, etc.), not to us. With styal Link, traffic rides a Cloudflare tunnel (`cloudflared` on your machine). The styal Link relay sets up the link. It does not proxy your HTTP or WebSocket sessions. styal does send product usage events (provider, model, token totals, that kind of thing) to styal's own analytics. No prompts, no file contents. That is the same on Tailscale, LAN, or styal Link. Set `T3CODE_TELEMETRY_ENABLED=false` if you want it off. [Product usage data](./telemetry.md)

## Worktrees are eating my disk. How do I clean them up?

Open **Settings > Storage** and turn on automatic worktree cleanup. You can also run it now from there. Worktrees add up fast. [Storage cleanup](./project-settings.md#storage-cleanup)

## Is there voice input?

On iPhone, yes. You need iOS 26 or later. Tap the mic in the composer, talk, check the text, then send. Web, desktop, and Android do not have it yet. [Voice input on iPhone](./composer.md#voice-input-on-iphone)

## Does it work on Windows, Mac, and Linux?

Yes: Apple Silicon Macs, Linux, and Windows, with the desktop app and the `styal` CLI. Intel Macs are not supported. On Windows, you can also run agents inside WSL. [Install](./install.md)

## How do I report a bug or send feedback?

Ask your agent to report it to styal, or choose **Send feedback** in the command palette or Settings → About. On mobile it is under Settings → Environments, on the environment you want to post from. The report becomes a public issue on [incognitojam/styal](https://github.com/incognitojam/styal/issues), posted under the GitHub account signed in on that environment, so leave out anything private. An agent's report is shown to you first and is posted only if you approve it. If that environment has no working GitHub sign-in, you get a link to post it yourself.

## Why is my provider not showing up?

Almost always, the CLI is not installed or not on the `PATH` of the machine that runs the server. (Not your phone. The computer.) Sign in from **Settings → Providers**, or on that machine with a command like `codex login` or `claude auth login`. Still missing? Point **Binary path** at it in provider settings. Version managers love to cause this one. [Provider setup](./install.md#providers)
