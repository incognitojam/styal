# Server updates

A [stable launcher](../../apps/server/src/serviceLauncher.ts) owns the runtime
selected by systemd or launchd. It is the only runtime writer of durable service
state. Server children request updates over inherited IPC; they never rewrite
their service definition or select their own replacement. Local service commands
may replace the launcher and state while the service is stopped. Foreground CLI
processes do not self-update.

Exact-version release archives keep restarts independent of a package cache or a
moving release tag. The server downloads the archive, verifies its SHA-256 against
the release checksum file, and extracts and preflights it in staging before
publishing an immutable runtime under `runtime/styal-executable/versions/<version>`.
Preflight checks the launcher protocol because a target that needs new rollback
guarantees cannot safely run under an older launcher. Upgrading that launcher
requires a local service update.

## Commit boundary

The launcher durably records the pending update before acknowledging it, then
stops the old child and starts the target as a trial. Service-state writes use
same-directory replacement with file and directory fsync. Invalid state stops
startup rather than guessing which runtime to boot.

The trial must finish migrations, acquire dependencies, bind HTTP, and park every
long-running root at the activation gate before reporting `prepared`. The launcher
then commits the target version durably and replies `committed`. Only then may the
child release its gates, accept commands, and publish ready. Keep fallible startup
acquisitions before this boundary. A listener alone does not prove the runtime is
ready to commit.

A failed or timed-out trial returns to the old version. After commit, the target
is authoritative and the service manager's ordinary restart policy applies.

## Database rollback

After the old child exits, the launcher snapshots SQLite's main file, WAL, and
shared-memory file. This makes trial migrations reversible without down
migrations. The snapshot is made once per update and survives launcher restarts;
replacing it during a retry could capture changes from the failed trial.

Rollback stops the trial before restoring. A durable restore marker makes an
interrupted restore finish before either version boots. Keep the snapshot until
commit, or until both restoration and the terminal rollback state are durable.
Attachments and other files outside SQLite are outside this rollback boundary.

## Client acknowledgement

An accepted update is still pending. Clients correlate the launcher's update ID
with the ready event after reconnecting, then check the outcome and target version.
A reconnect alone cannot distinguish successful replacement from rollback. Older
servers without an update ID retain version-only correlation.

Desktop updates have a separate two-phase handoff because installing the app stops
its bundled backend. Preparation returns a token while the connection is alive;
the client commits that token only after receiving it. Otherwise backend shutdown
could lose the only successful RPC result. The client must then observe the
prepared version after reconnecting. If installation fails, desktop restarts the
stopped backends and replays the failure for the same token.

## Styal executable archives

Runtimes live under `runtime/styal-executable/versions/<version>`, separate from the legacy
`runtime/versions` and protocol 3's `runtime/styal-cli`, so a matching version cannot reuse or
remove an old npm runtime. Launcher protocol 4 requires this layout. Protocol 3's integer was
fork-local: upstream also used 3 for a different layout, so the numbers are not interchangeable.

Older launchers fail preflight and need one local `npx @styal/cli@<version> service update`. The
npm launcher keeps `dist/bin.mjs` so old updaters can run that preflight and show its migration
guidance; it must remain until npm-based installations have migrated. Migration cannot defer the
restart while an older launcher is running.

Environment descriptors advertise `serverPackageName`. The shared update command refuses to send a
remote update to a server with an absent or different package identity, so a new styal client
cannot ask an old server to fetch `t3@<styal-version>`.

## Desktop updates on quit

electron-updater's `autoInstallOnAppQuit` stays off. Switching update tracks resets styal's ready
state but not the library's queued installer, and on macOS the flag hands the download to Squirrel,
after which it cannot be cancelled. Instead, after normal shutdown drains backend cleanup,
[`DesktopUpdates`](../../apps/desktop/src/updates/DesktopUpdates.ts) installs only a ready download
that still belongs to the selected track, silently and without relaunching. Any failure falls back
to an ordinary quit.

macOS reads `autoRunAppAfterInstall` rather than the `quitAndInstall` arguments, so the
[Electron adapter](../../apps/desktop/src/electron/ElectronUpdater.ts) sets it for both paths.
Shutdown keeps a one-shot `window-all-closed` listener while draining cleanup; without it,
Electron's default quit would bypass the update handoff.

## Desktop shutdown activity checks

Before a manual Quit, relaunch, or explicit update install, desktop asks each running backend in its
pool whether work is active. Unknown activity is never treated as idle: missing configuration,
invalid responses, and unreachable servers all require confirmation. The desktop bootstrap
credential stays valid for the server process's lifetime so a check after days of uptime still
authenticates. Independent remote servers do not block shutdown because the app does not own their
lifetime.

The confirmation dialog is mounted outside the authentication and recovery gates, and the renderer
must acknowledge that it is displayed, not merely queued. If presentation fails, the next explicit
Quit may bypass confirmation; update installs and settings restarts cannot consume that override.

This is a point-in-time check, not a shutdown lease: new work can arrive after the response. Do not
use it alone to authorize unattended restarts, which need an admission barrier spanning inspection
and shutdown.
