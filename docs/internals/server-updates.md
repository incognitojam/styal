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

The prepared deadline is long because migrations can scale with the database
and block the trial's main thread, so it cannot report progress. A missed
deadline restores the snapshot, and the retry pays the same cost again. A
crashed trial is caught when it exits; the deadline bounds only a stuck one.
Client update waits must outlast the deadline, or a slow update shows as failed.

## Database rollback

Before stopping the old child, the launcher refuses an update whose snapshot will
not fit on disk, so a full disk does not cause an outage. After the old child
exits, the launcher snapshots SQLite's main file, WAL, and shared-memory file. This makes trial migrations reversible without down
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
state but not the library's queued installer. Instead, after normal shutdown drains backend cleanup,
[`DesktopUpdates`](../../apps/desktop/src/updates/DesktopUpdates.ts) installs only a ready download
that still belongs to the selected track, silently and without relaunching. Any failure falls back
to an ordinary quit.

On macOS, Squirrel.Mac takes several seconds to unpack and verify an update, so
[desktop](../../apps/desktop/src/updates/DesktopNativeUpdateStaging.ts) stages a download as soon
as it finishes. Staging writes `~/Library/Caches/<bundle id>.ShipIt/ShipItState.plist`
and submits the `<bundle id>.ShipIt` launchd job, which installs that request on any exit, whether or
not the exit went through the update handoff. Staging cannot be cancelled, and Squirrel submits the
job only once per native updater, which electron-updater replaces at each download. Desktop therefore
keeps this simple: checks hold only while staging runs, a newer release or a track switch removes the
user launchd job (verified with `launchctl print`) before anything else downloads, and staging is skipped when Squirrel would
need administrator rights, which would put the job in the system domain. Every track switch runs
the discard, since a job can outlive the process that submitted it. When background staging failed
or was skipped, the handoff stages on the same native updater itself and waits for Squirrel's
outcome rather than calling MacUpdater's `quitAndInstall` unstaged: that waits only for success, and
after a discard its "already staged" flag, which never resets, makes it quit without staging. A
system-domain job left by an earlier administrator-rights install is not discarded.

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

## Recovering interrupted threads

Restart continuation is an environment-owned preference, on by default. A
`settings.json` that fails to decode turns it off, since the file may hold an
opt-out. The
[v2 recovery service](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
requires matching durable run, provider thread, session, and native resume identity.
Queued runs never started, so recovery holds them and continues the run they wait
behind. A settled run qualifies only when the restart cancels work the agent waits on
(a monitor, subagent, or background task) and its session was live, so stale records
from an older crash never wake it. Its continuation prompt is the note of what will not
report back. A shell alone does not wake a settled run: most are dev servers nobody
waits on, so that note waits for the next user message.

Recovery retires effects tied to the lost process and records continuation intent
in the durable outbox. That intent survives another restart before provider startup.
Continuation effects wait for activation; a slow provider must not delay the server's
readiness or the launcher's commit boundary. The early graceful shutdown step closes
command admission and stops the effect worker before capturing intent and closing
providers; otherwise the stopping process can consume intent meant for its successor.
Reconciliation runs after ingestion has stopped so a late completion cannot be
overwritten by a stale cancellation.

The [continuation handler](../../apps/server/src/orchestration-v2/RestartContinuation.ts)
rechecks the preference, provider selection, newer user work, a stop the user requested,
and maintenance turns such as `/compact` before dispatching. Intent and delivery both
refuse a thread that is archived, settled, or still snoozed, a cut turn whose provider
turn already ended, and a run waiting on the user: an approval, question, or secret that was pending,
or that recovery closed on the cut turn. Message-capable questions stay answerable, so
they do not block. Delivery also stops after three consecutive continuations in one
`restartContinuationOfRunId` chain, so a turn that crashes the server cannot loop. Stable
command and message IDs prevent duplicate submissions after an outbox retry. Codex
resumes without adding provider prompt text unless the turn lost background work;
other adapters receive the continuation message through their normal turn path.

Delegated tasks (`delegate_task` child threads) are reconciled as their own threads,
never as the parent's background work. The orchestrator settles child results and
completion deliveries in a startup pass after reconciliation, because the terminal-run
listener ignores reconciliation's cancellations. A cancelled child whose restart
continuation is still pending in the outbox is not a result yet; the continuation's run
settles it, or the handler settles it when it declines to continue. Schedulers wait for
activation so they cannot start runs that reconciliation would then cancel.
