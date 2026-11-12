# Updating styal

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, the update button at the bottom
of the sidebar and **Settings → Machines** offer to update it.

## Update everything at once

The update button at the bottom of the sidebar updates every connected machine
in one step. It updates outdated providers, then servers that are behind, then
the desktop app you are using. Servers move to the
version your desktop app is installing, or to your web app's version. A
background service stays on its current release channel. A remote desktop app
installs the latest release from its own channel. Hover the button to see what
it will update.

While it runs, the button widens to show progress. It names a machine that is
taking longer than usual, and offers **Retry** for a server that failed. Click
it to see every machine. The desktop app restarts once each server has started
its own restart. A manually requested update adds no restart countdown. A server still restarting
finishes on its own, and the button keeps showing it after the desktop app
restarts.

Each server checks that it can install the release before it restarts. If the
release is not available to a server yet, its update fails, the server keeps
running, and you can retry. The confirmation lists each machine it skips and
why, such as a machine that is offline or needs a manual update. Use
**Settings → Machines** for those.
The final update summary also names skipped machines and their reasons, including
after the desktop app restarts.

If a desktop app restarts on its old version, styal tells you the update did
not apply. It does not install that version again on its own, on quit or when
another device asks. Use the update button on that machine to retry.

When all affected work can continue, updating proceeds without another confirmation.
Otherwise, the combined confirmation lists affected threads by environment and project,
separating work that resumes on its own from work that stops until you message it. Terminal
commands and activity that could not be checked remain warnings. One confirmation
covers the matching downloaded app update; older desktop apps can still ask at
installation. See **Continue threads after restarts** below.

## Switch between Stable and Nightly

In the desktop app, change **Settings → About → Update track**. styal shows each
connected machine it will move and each one it skips, then moves them in one
step. Remote servers install the latest release on the new track. Remote desktop
apps reinstall on the new track. This app reinstalls last. Your threads,
settings, and data stay.

A background service cannot move to an older release remotely. When Stable is
older than its Nightly, run `styal update --channel stable --allow-downgrade` on
that machine.

A switch is blocked for a machine whose database already has changes the
target release does not support, or when styal cannot confirm that it does.
The dialog says why: update a machine on its current track first when its
release is too old to check, or wait until the target track includes the
changes. A Mac running the desktop app must switch on that Mac.

Each machine keeps the new track even if its switch did not finish, but it
moves to that track only through a switch. **Update track** shows how many
machines still run the other track. **Review** opens the same dialog with fresh
checks.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain. Before
updating, styal checks the server for active agents, threads waiting for input,
running terminal commands, and provider updates being installed, including work
started from other devices. If
work would be interrupted or the check fails, styal lists it and asks you to confirm.
If the check takes longer than two seconds, the confirmation opens while it continues:
choose **Update anyway** to update without waiting, or wait for the result to appear.
Resumable agent turns do not need confirmation. Running terminal commands, waiting
approvals or questions, provider installs, and devices used by another environment do.

Updating a remote desktop app also checks its other hosted environments, including
WSL. The confirmation lists threads from the environment you connected to and
counts other hosted work without revealing its thread or project names. If part
of the desktop app cannot be checked, the confirmation says so.

**Settings → Maintenance → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
styal must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
Continuation does not preserve running processes: a command inside an agent turn
may stop, and the resumed agent must check and recover unfinished work.
A thread that finished its turn to wait on a subagent, a background task, or a
command or monitor the agent said it was waiting on is woken and asked to restart the
work it still needs. Other background shells and monitors, such as a dev server and
its watchdog, do not wake it; the thread learns about them with your next message.
A thread whose turn continues shows **Continued after server restart** where
the agent picked up again, and a thread asked to restart background work shows
**Asked to restart background work after server restart**.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three automatic resumes in a row,
the thread waits for your next message.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older T3 Code versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update
  T3 Code on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

Update the side the notice names, then reconnect.

## Update a connected server

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Update instructions**    | Copy the command shown and run it in a separate terminal or SSH session on the host, keeping your usual startup options.                                                                        |

For a background service that needs its one-time migration, run the matching
version's CLI on the host:

```sh
npx @styal/cli@<client-version> service update
```

Replace `<client-version>` with the version shown in the notice. An older service
launcher needs this local update before it supports remote updates and rollback.
See [migrating an existing installation](./background-service.md#migrating-an-existing-styal-installation).

For a foreground server installed with `npm install -g @styal/cli`, the
instructions show
`npm install --global --prefix <prefix> @styal/cli@<client-version>` with the
npm prefix the server runs from. Run it on the host, then stop the server and
start `styal` again with your usual options. On Windows, or when the server
cannot confirm its npm installation, the instructions show the relaunch command
below instead; update a global install with `npm install -g @styal/cli@<client-version>`.

For a foreground server started with `npx`, `pnpm dlx`, or `bunx`, stop it, then
relaunch with the same runner, for example `npx @styal/cli@<client-version> serve`,
preserving options such as `--host` or `--tailscale-serve`. This runs the new
version without updating an installed `styal` command.

If styal runs under a service or container that you manage yourself, update it
through your existing deployment method. See
[background services](./background-service.md) for service management.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If work starts that would be interrupted
while a remote update downloads, styal keeps running and retains the download. Retry
to review the current work and confirm the restart. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

## Web app updates

When a new web build is deployed, the sidebar offers **New build available — Refresh**.
Choose it when you are ready to reload. Your saved connections and composer text drafts remain;
refreshing does not update or restart your connected servers. This also works in web previews.

## Desktop app updates

The desktop app downloads updates in the background and installs them when you
quit, ready for your next launch. On macOS, closing the last window leaves the
app running; choose **Quit** to install. To apply a downloaded update right away,
select **Restart to update** in the sidebar. Update checks, download progress,
retries, and the update track are in **Settings**. Changing the track cancels a
pending update from the previous track.
After an update installs, the desktop app names the version it updated to the
next time you look at its window, with a link to that version's release notes.

Before quitting or restarting, styal checks agents and terminal commands in the
environments the desktop app hosts, including WSL and work started from other
devices. A restart proceeds directly when every check succeeds and all active
threads can continue. Terminal commands, waiting requests and unchecked activity
still require confirmation. Quit asks about active work even when threads can
continue, because they resume only when styal next starts. You can cancel or
continue; cancelling keeps the downloaded update. If the confirmation
cannot be displayed and the app stays unresponsive, choose **Quit** again after
five seconds to exit. This can interrupt running work.

Only one server can use a styal home directory at a time. If startup reports that
another server owns it, stop that server before retrying, or use a separate home
directory and pair with the running server.

## Try a pull request's preview

On an Apple Silicon Mac, the desktop app can install the unsigned preview build of a pull request in
this project's repository that has the `preview:mac` label. Open the pull request and choose
**Install and open** once its build has finished. styal downloads the build, checks it against the
digest GitHub published, installs `styal (Preview)` in `~/Applications`, and opens it. It runs beside
your main app with its own projects, threads, and sign-ins in `~/.styal/preview`.

There is one preview at a time, and every preview shares that data. Installing another build quits
the running preview and replaces it. If it has work to confirm and does not quit, finish that and try
again; your previous build stays installed until then.

When the pull request closes, styal removes the app the next time the preview is not running. To
remove it sooner, use the menu beside the button or **Settings → About**. Removing the app keeps its
data. If a preview misbehaves after switching between pull requests, choose **Reset preview data** in
the same places to delete that data and start empty. Your main styal app's data is never touched.

If macOS quarantines a build, styal says so and does not install it. Use the DMG link and `xattr`
command from the pull request's preview comment instead.

## If the desktop app does not start

If the desktop app's server keeps failing at startup, styal shows a "styal
could not start" window instead of the app. If a newer version is available,
choose **Update** to install it. If not, the window links to the last version
that started on your computer. Download and install it to go back. Use **Copy
details** to include the error in a bug report.

## Registries and proxies

Each server checks styal releases, and providers installed with npm, through
its own npm, so the checks use npm's configured registry, authentication, and
proxy settings. Providers installed with Homebrew or pnpm check through those
tools.
Configure npm on the server's machine. If that registry cannot be reached, the
release shows as unavailable; styal does not try the public registry instead.
Machines without npm check the public npm registry directly.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. Providers that only
offer a manual update command are not included.

After a successful provider CLI update, styal refreshes model discovery for
every enabled instance of that provider using its own configuration. Connected
clients receive the refreshed catalogs automatically. Provider update checks
must be enabled to download the latest styal model catalog.

Provider updates do not restart running chats. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the provider
status and refresh it again.

<a id="styal-managed-updates"></a>

### Automatically install styal-tested provider updates

With **Automatically install styal-tested provider updates** on, styal takes over automatic updates for supported providers. It
installs only versions it has tested: an automated check runs real agent turns
against each new Codex, Claude Code, and OpenCode release on the latest nightly
and an older nightly published within the last seven days. It installs in the background once none of that
provider's threads are running or waiting for you. A question left unanswered
for over an hour after the agent finished does not hold it back. A turn that
starts during an install waits for it. styal never moves a provider back, and
it does not show an update prompt for providers it manages. **Settings →
Providers** says when the newest release has not been tested yet, and you can
still install it yourself.

Managed updates are on by default. Turn them on or off in **Settings → Maintenance**;
they need provider update checks on.
Refreshing provider status also checks for approved updates immediately when
you have permission to manage providers. Installation continues in the background;
the usual checks still apply, including waiting while a provider is busy.
They cover providers installed with npm, Bun, pnpm, Yarn, Vite+, or Volta, and
Claude Code installed with its own installer on macOS, Linux, and Windows.
Codex and OpenCode 2 native installs are covered on macOS and Linux.
WinGet, Homebrew, unrecognized install locations, and other native installers
keep updating the way they always have.

For native Claude Code and Codex installs, styal manages updates in place of the
provider's own updater. If one already has the tested version, styal reinstalls
that same version in the background to take over its updates. For Claude Code,
styal adds `DISABLE_AUTOUPDATER` to the `env` block of its `settings.json`, with
`STYAL_MANAGED_UPDATES` to mark it as styal's; a value you set yourself is left
alone. To hand updates back to the provider, turn managed updates off, then
select **Update** for it in **Settings → Providers** once. Native OpenCode
keeps its own `autoupdate` setting, so turn that off if you only want tested
versions.

## Mobile updates

To update an environment from your phone, open **Settings → Environments on mobile** and
select it. **Check for updates** finds the latest release on that environment's
current release channel. Updating asks for confirmation if work would be interrupted
or could not be checked, listing affected threads and which can continue. Otherwise
it proceeds directly. Keep the app open while the
environment updates and reconnects. Hosts that cannot update remotely show instructions for updating on
the machine instead.

The same page lets you refresh provider status and update supported providers.
These controls require a connected environment and permission to operate it.
Provider update checks and restart continuation preferences are in
**Settings → Maintenance**. If provider update checks are disabled, enable them
there before refreshing to find newer versions. The same setting controls whether
styal downloads model catalog updates, so with it off new models may not appear
until you enable it and refresh provider status.

The mobile app can download updates in the background and apply them when you
next leave the app. It saves drafts and queued messages before restarting. If you
keep the app open for a long time, it may ask to install immediately; choosing
**Later** leaves the update queued for the next suitable moment.

Some updates need a new app build. On Android, styal offers to download the new
build once, and keeps it available in **Settings → About** until you
install it. Open the downloaded APK to install it over the current app; your
saved environments are kept. You can also install the newest **styal for
Android** release from GitHub, as described in [installing the mobile
app](./install.md#mobile-app).
