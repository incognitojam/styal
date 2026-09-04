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

The launcher and installer select `runtime/styal-executable/versions/<version>/styal`
(`styal.exe` on Windows). Archives come from `incognitojam/styal`. The directory is
separate from both legacy `runtime/versions` and protocol 3's `runtime/styal-cli`
installs, so a matching version cannot reuse or remove an old npm runtime.

Launcher protocol 4 requires this executable layout. Protocol 3's integer was fork-local:
upstream also used 3 for a different layout, so their numbers are not interchangeable.
Older launchers fail preflight and need one local
`npx @styal/cli@<version> service update`. The npm launcher retains `dist/bin.mjs`
so old updaters can run that preflight and display its migration guidance. It must
remain until the supported npm-based installations have migrated.

The local command prepares the archive before stopping the service. If activation
fails, it restores the stopped service's state and unit definition, reloads the
service manager configuration, and attempts recovery. Migration cannot defer the
restart while an older launcher is running. Protocol 4 updates may defer restart;
`.restart-pending` keeps status accurate until the new launcher starts. Data paths
and the remote database rollback boundary are unchanged.

Environment descriptors advertise `serverPackageName`. Clients offer the local
service migration command for older boot services with an absent or different
package identity, and the shared update command refuses to send a remote update
to them. This prevents a new styal client from asking an old server to fetch
`t3@<styal-version>` during the rollout.

## Desktop updates on quit

Desktop downloads stay staged in electron-updater until installation is requested. Its
`autoInstallOnAppQuit` flag intentionally stays off: switching update tracks resets styal's ready
state but does not remove the library's queued installer. On macOS, enabling the flag also hands the
download to Squirrel, after which changing the JavaScript flag cannot cancel native installation.

After normal shutdown closes the windows and drains backend cleanup, `DesktopLifecycle` asks
`DesktopUpdates.installOnQuit` whether a ready download still belongs to the selected track. Only
that download is handed to the installer, silently and without relaunching. A track change or failed
replacement download leaves the old installer ineligible. Native staging errors or a 30-second
handoff timeout fall back to ordinary quit. Explicit **Restart to update** retains its relaunch
behavior. macOS reads `autoRunAppAfterInstall` rather than the `quitAndInstall` arguments, so the
Electron adapter sets that property explicitly for both paths.

Shutdown retains a one-shot `window-all-closed` listener while draining cleanup. Native delivery
can follow removal of the scoped lifecycle listeners; without a remaining listener, Electron's
default quit would bypass the update handoff.

## Desktop shutdown activity checks

`DesktopShutdownGuard` checks every backend registered in the desktop pool before manual Quit,
relaunch, or explicit update installation. Deliberately stopped instances are skipped. Each running
instance is queried through its authenticated `/api/environment/activity` endpoint with a three-second
budget. Missing configuration, invalid responses, and unavailable instances require confirmation;
they never count as idle. The desktop bootstrap credential remains valid for the owning server process
lifetime, so a first check after days of uptime or a later bearer renewal still works. User pairing
links and issued bearer sessions keep their normal expiry. The existing in-app confirmation dialog presents active or unknown work; idle checks
proceed immediately. Duplicate requests are suppressed. The confirmation host is mounted outside authentication and recovery gates. The main process reopens
the main window when needed and gives the renderer five seconds to acknowledge that the dialog is
active, rather than merely queued. Once displayed, it waits for the user without a deadline.

Failed presentation expires the request and allows a subsequent explicit Quit to bypass confirmation
while retaining normal shutdown and cleanup. Update installation and settings restarts cannot consume
this override. Displaying a dialog or recovering the renderer clears it; late acknowledgments and
responses to expired requests are ignored. Closing the window cancels the request without arming an
override. Unknown activity is never treated as idle.

The server combines lightweight thread projections with live provider sessions, including pending
approvals/input, starting turns, and background work. Terminal checks reuse the fresh close preflight,
including finite commands and conservative handling when process inspection fails. Failed terminal
inspections are counted separately so the dialog distinguishes running work from unknown activity. Results cover all
clients of that environment without loading message bodies or transmitting thread names. Connections
to independent remote servers do not block desktop shutdown because this app does not own their lifetime.

Idle manual requests proceed without a dialog. Windows and Linux window closes route through Quit
before destroying the main window, so cancellation retains it. macOS window-close behavior and the
hold-to-quit shortcut stay unchanged. OS/process termination signals and updater-controlled final quits
bypass interactive checks. Cancellation leaves the downloaded installer eligible for a later attempt. Restart-triggering network
and WSL settings changes restore their previous values when relaunch is declined.

This is a point-in-time check, not a shutdown lease: new work can arrive after the response. Do not use
it alone to authorize unattended restart; that needs an admission barrier spanning activity inspection
and shutdown. Service updates are not changed by this desktop guard.
