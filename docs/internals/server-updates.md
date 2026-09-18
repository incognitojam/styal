# Server Update Architecture

> For maintainers. Using styal? See [docs/user](../user/).

Remote server updates use one stable launcher selected by the platform service manager (systemd on
Linux, launchd on macOS). Foreground CLI processes do not self-update, and a running server never
edits its service definition or durable service state.

## Ownership

The service files under `<baseDir>/runtime` are:

- `service-launcher.mjs`, the stable process selected by the service manager;
- `service-state.json`, the launcher's durable selection state;
- `styal-cli/versions/<version>`, immutable exact-version npm installs.

The launcher is the only runtime writer of `service-state.json`. `styal service install` and
`styal service update` may replace the launcher and state while the unit is stopped. Server children
only communicate with the launcher over their inherited IPC channel.

The state contains one active version and, at most, one update record:

- `pending A → B` selects B as a retryable trial;
- `committed A → B` selects B for ordinary restarts;
- `rolled-back A → B` or `failed A → B` selects A;
- invalid state fails closed so the service manager cannot guess at a runtime.

Every write uses same-directory replacement plus file and directory fsync.

## Remote Update

1. The active server installs `@styal/cli@<target>` into a unique staging directory.
2. The target runs `__service-preflight` and verifies that the stable launcher supports its update
   protocol.
3. The staging directory is renamed to its immutable version path only after preflight succeeds.
4. The active child sends `request-update`. The launcher validates the child and target, writes
   pending state, generates the update ID, then replies `update-accepted`.
5. After a short response-flush grace period, the launcher stops the active child.
6. With SQLite quiescent, the launcher snapshots the database, WAL, and shared-memory files.
7. The launcher starts the target as a trial and gives it the pending update over IPC.
8. The trial runs migrations, acquires dependencies, binds HTTP, starts every long-running root
   fiber, and verifies that each root is parked at the activation gate.
9. The trial sends `prepared`. The launcher durably commits B, deletes the snapshot, then replies
   `committed`.
10. The child opens the existing activation gate, accepts commands, and publishes lifecycle ready
    with the terminal update outcome.

Post-commit startup does not call service `start`, `initialize`, `connect`, `load`, or `acquire`
operations. It only opens prepared gates and publishes prepared lifecycle state.

The launcher serializes child exits, IPC messages, and timers. A trial must report prepared within
120 seconds. If the trial exits or times out before prepared, the launcher stops it, restores the
snapshot, records rollback, and starts A. A durable restore marker makes an interrupted restore
resume before either version can boot. After commit, B is active and the service manager's normal
restart policy applies.

## Database Rollback

The launcher snapshots `state.sqlite`, `state.sqlite-wal`, and `state.sqlite-shm` after the old
server stops and before the trial starts. This makes trial migrations and writes reversible without
requiring down migrations. The snapshot is retained across launcher restarts and is removed only
after commit or after both restore and the terminal rollback state are durable.

The protocol version is part of the safety boundary. A target that requires database snapshots is
blocked when the installed launcher is too old. Upgrade the launcher once with:

```sh
npx @styal/cli@<version> service update
```

The local command stops the unit, selects the new launcher and exact runtime, then restarts the
service. Later releases, including releases with migrations, can use the remote trial path.

Snapshots briefly require enough free disk for another copy of the SQLite files. Attachments and
other files under the state directory are outside this rollback boundary.

## Client Correlation

The update acknowledgement includes the launcher-generated update ID. After reconnecting, clients
wait for a lifecycle ready event carrying that same ID. `committed` completes the operation only
when the ready server is the target version. `rolled-back` and `failed` end it immediately with the
recorded reason. Older servers without an ID retain version-only reconnect behavior.

## Capability and Compatibility

The existing additive RPC and lifecycle schemas remain compatible with older clients. New servers
advertise remote self-update only when they have valid launcher context and a live IPC channel.
Desktop-managed servers direct the user to update the desktop app. Other process shapes provide a
manual command; the old detached foreground respawn path no longer exists.

## Desktop Updates on Quit

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

## Source Map

- Launcher and state machine: `apps/server/src/serviceLauncher.ts`
- IPC and durable state types: `apps/server/src/cloud/serviceProtocol.ts`
- Child IPC adapter: `apps/server/src/cloud/serviceLauncherClient.ts`
- Staging and preflight: `apps/server/src/cloud/pinnedRuntime.ts` and `servicePreflight.ts`
- Service installation: `apps/server/src/cloud/bootService.ts`
- Activation boundary: `apps/server/src/serverRuntimeStartup.ts` and `serverActivation.ts`
- Client outcome correlation: `packages/client-runtime/src/state/server.ts`

## CLI Package Identity

The launcher and installer select `@styal/cli` from
`runtime/styal-cli/versions/<version>/node_modules/@styal/cli/dist/bin.mjs`.
The directory is separate from legacy `runtime/versions/<version>` installs so a
matching version cannot reuse or remove a running `t3` package.

Launcher protocol 3 requires this layout. Older launchers fail preflight and need
one local `npx @styal/cli@<version> service update`, which prepares the new runtime
before stopping the service and replacing its launcher. Database and project paths
are unchanged. Remote rollback operates between runtimes using the new layout;
the one-time launcher migration is a local operation.

Environment descriptors advertise `serverPackageName`. Clients offer the local
service migration command for older boot services with an absent or different
package identity, and the shared update command refuses to send a remote update
to them. This prevents a new styal client from asking an old server to fetch
`t3@<styal-version>` during the rollout.
