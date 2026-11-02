# Development

## First checkout

Install `vp` using the [root README](../../README.md#development). It provides the Node version
pinned in `package.json` (Node 26), so no separate Node install is needed. From the repository root:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner. The bare origin does not authenticate
a new browser.

Prefer a container? See [Dev container](../internals/devcontainer.md) for VS Code and Codespaces setup.

## Upstream GitCafe mirror

Upstream T3 Code also uses a GitCafe mirror. This fork uses GitHub `incognitojam/styal` for branches, pull requests, checks, and merging; keep `origin` pointed at the fork. Upstream instructions to push and track pull requests through GitCafe apply only to checkouts whose origin is git.cafe, not to this fork. In those checkouts, cafe 0.11 or newer can read GitHub Actions logs with `cafe ci logs <run>` (run ids from `cafe ci list --pr <n>`) and rerun a workflow with `cafe ci rerun <run>`.

## Choosing a dev process

Use `vp run dev` for server and web, or `vp run dev:desktop` for the Electron client.
`dev:server` and `dev:web` start those processes separately.
See the [mobile README](../../apps/mobile/README.md) for native builds and Metro.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/styal-dev`.
Add `--browser` to open a browser automatically.

### State and ports

Linked worktrees default to their own `.styal/userdata`, even when `STYAL_HOME` is set.
The main checkout defaults to `~/.styal/dev/userdata`. An explicit `--home-dir` wins in both cases.
The first start copies the shared offline `~/.styal/dev-seed/statev2.sqlite` when the worktree has no database and the seed is at most 500 MiB. Missing or oversized seeds start empty with a message. Old seeds are acceptable. `--no-seed` or `T3CODE_DEV_SEED=0` skips seeding. Dev startup never reads the live database.

Run `vp run build-dev-seed` explicitly on a POSIX host with Python 3 to refresh the seed, from a checkout matching the installed server's migrations. It serializes builders across worktrees and attempts at most one refresh per day. Its read-only incremental backup releases the source read lock between 256-page steps, and the snapshot subprocess is killed after 30 seconds. All pruning, migration and compaction happen on the offline snapshot. A failed refresh retains the old seed. The seed keeps recent stopped thread families and removes scheduled tasks, pending work, auth sessions and environment links.

With dev stopped, `vp run migrate-dev-db` refreshes a worktree from that seed. `--source` is for offline databases, never the live install. Data only flows into the sandbox; never run a dev server against `~/.styal/userdata` or copy data back there. See [test data](../../AGENTS.md#test-data).

A worktree's settle action can run `node scripts/teardown-worktree.ts`. When the last open thread
there settles, it stops the worktree's `dev-runner` processes and anything else from the worktree
listening on the workspace's ports, then deletes `.styal/userdata` and `.styal/caches`, the paths
listed in the script. Other servers on other ports keep running.
`.styal/worktrees` and `.scratch` stay. Older worktrees lack the script, so save the action as
`if [ -f scripts/teardown-worktree.ts ]; then node scripts/teardown-worktree.ts; fi`.

Read ports from the `[dev-runner]` output. Worktrees derive stable preferences from their paths,
but occupied ports can shift them. `T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a
different preference when needed.

### Replay provider

`vp run dev` registers `Replay (dev)`, a local ACP agent at
[dev-replay-agent.ts](../../apps/server/scripts/dev-replay-agent.ts). It plays recorded
ACP transcripts with simulated streaming, so the real adapter, orchestration, and UI run
without a paid model. Each scenario is a model, and each prompt plays the next recorded turn.
Bundled servers, including desktop dev, skip it because they have no agent script.
Dev servers add it back on start, so turn it off in Settings instead of removing it.
To add a scenario, point a `SCENARIOS` entry at a generic ACP replay fixture
(`registry_transcript.ndjson`) or a file in [dev-replay](../../apps/server/scripts/dev-replay).
The agent replays session updates, permission requests, and questions. It drops session setup
and vendor frames, so Grok and fx recordings lose their vendor-only behavior.

### Profiling dev startup

Run `vp run profile:startup` to capture the first 20 seconds of inherited Node processes under
`.styal/startup-profiles/<timestamp>`. Workers that execute the preload get separate profiles.
It starts the normal dev runner and accepts its flags.
Stop it with Ctrl+C after the capture. Set `T3CODE_STARTUP_PROFILE_DIR` to choose another output
directory. Profiling adds overhead, so compare readiness with an ordinary `vp run dev` run.

Open a `.cpuprofile` in Chrome DevTools' Performance panel for sampled function stacks and source
lines. Each `.modules.json` is a Chrome trace containing timed module resolution, loading,
synchronous subprocess calls, and startup measures. Per-file records include importer URLs,
source loading, preparation, recursive dependency linking, and top-level evaluation. Preparation
uses synchronous loader boundaries; linking includes dependencies, and CommonJS evaluation can
include nested `require` calls. Some ESM/CommonJS interop reports a combined stage. `.process.json` records the process, Node version, and capture window.
The server's nested Effect and SQL spans remain in `.styal/userdata/logs/server.trace.ndjson`.

The preload temporarily adds module-body timing markers and uses one automatic debugger pause
to instrument the live Node loader. The launcher adds `--no-node-snapshot` to inherited
`NODE_OPTIONS` because Node 26's snapshotted loader cannot accept that breakpoint. Include the
same flag when using the preload directly. This disables Node's built-in startup snapshot,
can change compilation-cache hits, and adds overhead.
Treat per-file captures as diagnostic runs; use uninstrumented runs for baseline startup latency.
The first entry module can compile before loader instrumentation is installed.

A fresh process still uses filesystem, Node compilation, provider, and Vite dependency caches.
Measure a missing Vite dependency cache separately from a restart with an existing database.
Neither the Vite ready message nor the HTTP listener proves that a browser has rendered the app.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL
for that origin. Give the tester the complete URL, including its token. A desktop build, such as
a PR preview DMG, can pair with it from **Settings → Environments → Add environment** to test
against the shared server. The dev runner removes its mapping on exit.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies the backend through the browser's
origin so the same build works over localhost and remote connections.

Shared runs enable bundled dev to avoid a network round trip for each import level.
`T3CODE_BUNDLED_DEV=0` opts out when debugging bundler differences. Two reload traps matter
when changing this setup:

- The web entry must dynamically import the app so React refresh initializes before application
  chunks. Static imports can work on first load and fail after a route split.
- Bundled dev rebuilds Tailwind through watched files. Its ordinary Vite hot-update hook expects
  a server/module graph that Rolldown does not provide.
- The app and its routes are lazy chunks, built on first request. A plugin pre-bundles the
  startup chain when the server starts. Renaming or moving a startup route or the app entry
  silently drops it from that list.

The workarounds live in the [web entry](../../apps/web/src/bootstrap.ts),
[Tailwind plugin](../../apps/web/vite/tailwind.ts), and
[startup warmup](../../apps/web/vite/warmBundledDev.ts).

`vp run dev --share --built` skips the Vite dev server. It runs `vp build --watch` for the web
app, and the backend serves `apps/web/dist` on the same tailnet URL and pairing flow. Use it when
someone tests over a slow link or only needs to use the app: loads are production size, and the
first load does not wait for dev bundling. There is no HMR. After an edit, wait for the
`built in` line (about 6 s), then reload. Until the first build exists, the URL shows a page that
reloads by itself. The license manifest is not generated in this mode. `--built` requires
`--share` and the `dev` mode.

#### Reusable dev credential

Use this only on a hostname where you trust every service. Browsers send cookies to all ports
on that hostname. Any service you visit there can receive the reusable admin credential,
including services unrelated to styal. If you run untrusted services on that hostname, keep
normal per-environment pairing instead.

To use one browser profile across web dev worktrees on the same hostname, generate one fixed
value once:

```sh
openssl rand -hex 32
```

Put that value in the main checkout's gitignored `.env`:

```dotenv
T3CODE_DEV_AUTH_TOKEN=<the value generated above>
```

The `t3.json` Setup Worktree action links that file to each worktree's `.env`. The dev runner reads repository env files at startup. `.env.local` and inherited process
environment values override `.env`, so no per-worktree export is needed after setup.

For a manual worktree or launcher without that link, export the same fixed value instead:

```sh
export T3CODE_DEV_AUTH_TOKEN="<the value generated above>"
```

Do not generate a new value at startup. Start or restart `vp run dev --share` after configuration,
then open its printed startup pairing URL once per browser profile on that hostname. Later web dev
servers on the same hostname accept the shared cookie across ports. The cookie expires after 30
days. Reload an old tab if its URL now serves a replacement environment.

The token and startup pairing URLs are reusable administrative secrets. Never put them in a
commit, pull request, or public output. Every server still seeds its own auth database record at
startup and keeps its own SQLite data, signing key, and revocation state. Desktop and non-dev
servers ignore the value. See [environment authentication](../internals/environment-auth.md#reusable-dev-credential)
for the security model.

## Checks

### Desktop lifecycle measurements

On Linux, with Xvfb installed, measure startup and quit of the built desktop app:

```sh
vp run build:desktop
vp run --filter @t3tools/desktop ensure:electron
xvfb-run -a node apps/desktop/scripts/measure-lifecycle.mjs --samples 5
```

Each run writes reports, logs, and traces to a new `.scratch/lifecycle-*` directory, using isolated state and synthetic history (an empty scenario and one with 200 threads). Ready means the client has connected and received server configuration and its first shell snapshot. A sample fails if the backend is force-killed, leaves children running, or keeps its port. The **Lifecycle Performance** workflow runs the same measurement when dispatched manually; it reports timings but does not enforce limits.

Things to keep in mind when comparing builds:

- Compare runs on the same host, alternating builds. Provider checks use the host's installed tools and network.
- Ready fires before the renderer finishes drawing history, so an immediate quit includes that rendering. Pass `--settle-ms 1000` to measure quit on its own.
- The history is seeded as projections, so event replay and active provider recovery are not measured. Neither are packaged installers, macOS, or Windows.

### Focused checks

`vp run check:changed` runs CI's fast checks for your branch's changes: format and lint of the
changed files, `knip:check` when code or a manifest changes, the generated GraphQL checks, typecheck
of the affected packages and their dependents, and the test files beside the changed files. It also
runs the checks that read other files: the agent context budget when the server is affected, and
React Compiler coverage for only the changed web and mobile files. It maps
files to packages with [ci-changes.cjs](../../.github/scripts/ci-changes.cjs), as CI does. It
compares against the closest merge base with any remote's `main`, so a fork whose `main` lags
upstream still compares against upstream, or with a ref you pass. CI still runs the full
test suites and the jobs the summary lists, so a local pass does not promise a green CI run.

The steps run side by side, as many at once as the machine allows: one per two cores and per 6 GiB
of available memory. On a large machine a run takes about as long as its slowest step, usually
knip's exports pass at about 10 s. Pass `--concurrency <n>` or set `CHECK_CHANGED_CONCURRENCY` to
change the limit (`1` runs the steps one by one). A step that runs past `--timeout <seconds>` or
`CHECK_CHANGED_TIMEOUT` (default 900) is killed with every process it started and reported as
`TIMEOUT`, not as a failing check. When the files are exactly those of the last passing run, it prints that
run's summary instead of running again. Any change to a file, the install, or a generated file runs
the checks again.

While you iterate, run single checks:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

In `apps/web`, a test that renders React or touches the DOM is named `*.browser.test.{ts,tsx}`
and runs in headless Chromium with the React Compiler on, like the app. There is no jsdom; other
`*.test.ts` files run in Node.

TypeScript workspaces typecheck with `tsc`. The `typescript` catalog entry is
`@tsc-rs/typescript`, the tsc-rs drop-in, with Effect diagnostics, quick fixes, and
refactors built in. VS Code uses it through `js/ts.tsdk.path` in `.vscode/settings.json`.

Use `vp run lint:mobile` for native mobile changes. CI owns the full suite; see
[ci.yml](../../.github/workflows/ci.yml) for its current jobs.
The [manual Windows lane](../../.github/workflows/windows-tests.yml) is available for focused
Windows investigation while that suite is not a required gate.

### Unused code

`vp run knip:check` checks unused files and dependencies across the repo, then
unused runtime exports in `apps/server`, `apps/desktop`, `apps/web`, and every internal package under
`packages/`. CI enforces both checks.
Exported types and Effect schemas are allowed without consumers. The schema preprocessor
recognizes schema types, including aliases and schema classes; functions that create or decode
schemas remain checked. Canonical Effect service construction APIs stay exported with an explicit
`@public` annotation, which Knip recognizes. Completely unused files remain checked too.
Named exports in web UI component modules are kept as complete component sets. Knip ignores
unused exports in `apps/web/src/components/ui/*.tsx`, while still reporting an entire unused file.
Use `vp run knip --workspace apps/web` to audit one workspace, including exports,
or `vp run knip:production --workspace apps/web` to find code kept alive only by tests.
The full export audit still has findings and is not a repo-wide CI gate. Extend the
export check's workspace selectors as more workspaces become clean. Review callers before
deleting code; production mode can also report development scripts and test fixtures.
Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).

### End-to-end tests

`e2e/` drives the real web client in headless Chromium against a real server. Each test file
starts its own server on a free port with temporary state, an allowlisted environment, and a
throwaway home, so it never reads `~/.styal`, provider credentials, or your `gh` login. Codex is
[fake-codex](../../apps/server/scripts/fake-codex.ts), the other providers are off, and `gh` is a
[fake](../../e2e/fixtures/fake-gh.ts) that serves fixture issues. Tests can assert what the
provider received through fake-codex's request log.

```sh
vp run --filter @t3tools/e2e install:browser   # once per Playwright version
vp run --filter @t3tools/web build             # the server serves apps/web/dist
vp run --filter @t3tools/e2e test:e2e
```

Rebuild the web client after changing it; the server runs from source. CI sets
`E2E_SERVER_BUNDLE=1` to run `apps/server/dist/bin.mjs` instead, which starts faster; build it
with `vp run --filter @styal/cli build:bundle` and rebuild after server changes. Each environment's
directory holds the server log, the provider and `gh` call logs, and a screenshot of the page
when a test fails. It is kept when a test fails, or always with `E2E_KEEP_STATE=1`, and its path
is printed. CI runs the suite as the `E2E` shard of `Fork Test (Workspace)` and uploads kept
directories as the `e2e-state` artifact. Upstream intakes that break a covered fork flow fail
there.

Tests under `e2e/tests/network/` need npm and GitHub releases, such as a published `@styal/cli`
server running under its own service launcher and updating itself. They run only with
`E2E_NETWORK=1`. The update test takes the client and server versions from the environment, and
the web client must be built as the client version:

```sh
client=$(npm view @styal/cli dist-tags.nightly)
server=0.1.1-nightly.20261023.881   # a published nightly older than $client
APP_VERSION=$client vp run --filter @t3tools/web build
E2E_CLIENT_VERSION=$client E2E_PREVIOUS_SERVER_VERSION=$server \
  vp run --filter @t3tools/e2e test:e2e:network
```

The **Fork E2E (network)** workflow runs them daily and on intake pushes, with the newest nightly
as the client and the nightly before it as the server. Its result does not gate merges or
promotion; failed runs upload the `e2e-network-state` artifact.

## Desktop artifacts

Local artifact builds are unsigned by default and write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
```

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage`
to retain packaging files for inspection. Run `vp run dist:desktop:artifact --help` for other
options.

### Prepared server bytecode

Native macOS and Windows desktop artifact builds generate server bytecode with the packaged
Electron executable, after ASAR creation and before signing. Linux builds skip generation until
native packaging and relocated AppImage reuse have been validated. macOS x64 builds on ARM64
hosts run the packaged x64 Electron under Rosetta to generate the cache. Other cross-platform and
cross-architecture builds skip generation explicitly. CLI, SEA and WSL runtimes keep their
existing behavior; only desktop backend imports covered by generation receive prepared bytecode.
Worker-only modules compile normally.

Electron's Node 24 cache has no read-only option and includes the producer UID in its directory
name. The backend links individual prepared files into its writable cache with keys for the
installed module paths. Node replaces files atomically, so regeneration cannot write through those
links into signed resources. Windows uses hard links and falls back to normal caching when volumes
differ or resource permissions prevent linking. Protected installations therefore may not reuse
prepared bytecode. No cache bytes are copied during startup.

The key calculation follows Node's internal portable ESM format. Generation checks that the
packaged engine produced the expected CLI entry and fails the build if that format changes.
The manifest also checks Electron, Node, OS, architecture and V8's flags-sensitive version tag.
Missing or rejected entries compile from the shipped JavaScript. Prepared backends skip the
explicit startup flush; Node can persist missing entries on normal exit. The writable fallback
keeps the explicit flush needed when Windows force-kills the backend.

### Linux AppImage prerequisites

Build on Linux because the browser-secret helper links against the host's libsecret. Install
Rust, C/C++ build tools, libsecret development headers, pkg-config, and ImageMagick.

Ubuntu and Debian:

```sh
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-dev pkg-config imagemagick
```

Fedora:

```sh
sudo dnf install rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick
```

Arch Linux:

```sh
sudo pacman -S rust base-devel libsecret pkgconf imagemagick
```

The C toolchain, pkg-config, and libsecret headers are also needed for Linux desktop development.

### macOS DMG prerequisites

Install the Xcode Command Line Tools with `xcode-select --install` and install Rust.
For a cross-architecture or universal build, add the requested Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools with **Desktop development with C++**.
Include the Windows SDK and the MSVC build tools and Spectre-mitigated libraries for the target
architecture. Add its Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an ARM64 installer:
rustup target add aarch64-pc-windows-msvc
```

NSIS is downloaded by electron-builder. WSL support additionally needs a Linux node-pty prebuild;
see the [release runbook](./release.md#windows-payload-topology-and-update-validation).

### Signing and passkeys

Add `--signed` after configuring the platform credentials in the
[release runbook](./release.md). macOS passkeys need a signed, provisioned app; follow the
[Connect setup](./connect-setup.md#desktop-passkeys) for local signing and renderer HMR.

## PR previews

Label a pull request from a branch in this repository to build a preview on every push. The
workflow comments the link on the PR, and closing the PR or removing the label deletes the preview.
PRs from forks are skipped because they do not receive the credentials. When handing a
`preview:mac` build to someone, give the DMG link together with the `xattr` command from that
comment: the DMG is unsigned and macOS will not open it until the quarantine attribute is cleared.

- `preview:mac` builds an unsigned Apple Silicon DMG and attaches it to the rolling
  `desktop-preview` prerelease. It needs no setup beyond the repository variables in
  [styal Link](./styal-link.md#github-actions-configuration). The preview installs as a separate
  app, `styal (Preview)`, with its own empty state in `~/.styal/preview`, so it never reads or
  migrates a stable or nightly install's data. The desktop app on an Apple Silicon Mac can install
  it from the pull request panel; see [Try a pull request's preview](../user/updating.md#try-a-pull-requests-preview).
- `preview:windows` builds an unsigned Windows x64 installer, including the WSL runtime, and
  attaches it to the same `desktop-preview` prerelease. It installs as `styal (Preview)` with its
  own state in `%USERPROFILE%\.styal\preview`, and in `~/.styal/preview` inside WSL. SmartScreen
  warns about the unsigned installer; choose **More info**, then **Run anyway**.
- `preview:android` builds an arm64 APK and attaches it to the rolling `mobile-preview`
  prerelease, so it installs straight from a phone's browser. It installs as `styal Preview`
  beside the styal app, without push notifications or OTA updates. Every preview is signed with
  one preview key, so a newer build installs over an older one from any PR. One-time setup: an
  `android-preview` environment with no branch restriction holding
  `ANDROID_PREVIEW_KEYSTORE_BASE64` (a PKCS12 keystore with one key) and
  `ANDROID_PREVIEW_KEYSTORE_PASSWORD`. It must not be the production signing key.
- `preview:web` deploys the hosted web app to its own Cloudflare Worker at
  `https://styal-web-pr-<number>.<subdomain>.workers.dev`, without styal Link, so pair a server
  manually. Use an installed server or `styal serve`: a `vp run dev` server only accepts
  cross-origin requests from its own dev origins. One-time setup:
  - A Cloudflare API token limited to **Account > Workers Scripts: Edit**, stored as
    `CLOUDFLARE_API_TOKEN` on a `web-preview` environment with no branch restriction. It must
    not be the production token; see
    [Deployment credentials](./styal-link.md#deployment-credentials).
  - The repository variable `CLOUDFLARE_WORKERS_SUBDOMAIN`, set to the account's `workers.dev`
    subdomain.
