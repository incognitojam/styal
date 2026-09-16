# Running styal in the Background

On Linux and macOS, styal can run as a background service for your user, so it is ready without
keeping a terminal open.

## Manage the Service

Install it with the latest styal release:

```sh
npx @styal/cli@nightly service install
```

Check whether it is installed:

```sh
npx @styal/cli@nightly service status
```

Update or repair it:

```sh
npx @styal/cli@nightly service update
```

Stop it and remove it from startup:

```sh
npx @styal/cli@nightly service uninstall
```

Updating restarts styal briefly. Let active agent work and terminal commands finish first.
If a remote update is already in progress, wait for it to finish before retrying a local update.
Run local service commands in a separate terminal or SSH session: restarting the service can
close terminals opened inside styal.

Managed services offer **Update** in the chat notice and **Settings → Connections** when a
newer version is available. For detected legacy services, **Update instructions** provides the
one-time service migration command. Other servers get instructions to stop the existing server
and start the new version with the same startup options. A start command launches another server;
it does not update an existing service.

The service runs a small stable launcher. Exact styal versions are installed separately, so a
failed remote candidate can return to the previous version without rewriting the service
definition. The launcher snapshots the database before a remote candidate starts, so database
updates roll back with the server version. An older launcher may require one local
`service update` before this is available.

## Platform Support

**Linux** uses a systemd user unit at `~/.config/systemd/user/styal.service`. The service starts
when the machine boots and keeps running after you log out (lingering is enabled during install).

**macOS** uses a launch agent at `~/Library/LaunchAgents/build.styal.app.service.plist`. It
starts when you log in, not when the Mac boots, and it stops when you log out; macOS has no
equivalent of Linux lingering for user agents. For a Mac that should stay reachable unattended,
turn on automatic login (System Settings → Users & Groups; unavailable while FileVault is on) and
keep the Mac from sleeping.

A few more macOS notes:

- Installing over SSH needs someone logged in at the Mac's screen to start the agent right away.
  Without that, the install command reports an error at the final start step, but the agent is
  fully installed and starts at the next login.
- macOS may show privacy prompts for protected folders such as Desktop, Documents, or Downloads,
  attributed to a bare `node` process, or deny access without a prompt. If agent work fails to
  read those folders, grant Full Disk Access to the node binary listed in the launch agent's
  `ProgramArguments`.
- The agent appears under System Settings → General → Login Items. If it was switched off there,
  or disabled with `launchctl disable`, macOS will not start it at login until you switch it back
  on.

**Windows** is not supported yet.

## Using It with styal Link

styal Link may offer to install the service during setup so the host stays reachable in the
background. This is only an onboarding shortcut: the service and styal Link are managed separately.

Signing out of styal Link does not remove the service. Use `styal service uninstall` when you no longer
want styal to start in the background.

## Migrating an Existing styal Installation

If your background service's launcher installed the `t3` npm package, migrate it once on the
host using an exact released styal version:

```sh
npx @styal/cli@<version> service update
```

This installs the styal package and replaces the service launcher. Existing styal
threads, settings, and projects stay in the same data directory. If you use a
custom data directory, pass the same `--base-dir` you used before. Older package
installs are retained; the new launcher uses a separate runtime directory.

For a foreground process, stop your existing server after active work finishes,
then start `npx @styal/cli@<version> serve` with your existing startup options.

Containers without systemd or launchd should run `styal serve` under the container's
process supervisor. The CLI does not install a service manager.
