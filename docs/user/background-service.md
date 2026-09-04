# Running styal in the Background

On Linux and macOS, styal can run as a background service for your user, so it is ready without
keeping a terminal open.

## Manage the Service

Install it with the latest styal release:

```sh
npx @styal/cli@nightly service install
```

Check whether it is installed. On Linux this also checks whether the service is running, enabled
at startup, and allowed to keep running after logout:

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
one-time service migration command. When the installation method is unknown, the instructions
explain how to restart a terminal-launched server with the same startup options and direct service
or container users to their existing deployment method. A start command launches another server;
it does not update an existing service.

The service runs a small stable launcher. Exact styal versions are installed separately, so a
failed remote candidate can return to the previous version without rewriting the service
definition. The launcher snapshots the database before a remote candidate starts, so database
updates roll back with the server version. An older launcher may require one local
`service update` before this is available.

## Platform Support

**Linux** uses a systemd user unit at `~/.config/systemd/user/styal.service`. The service starts
when the machine boots and keeps running after you log out (lingering is enabled during install).
Setup checks the systemd user manager and enables lingering before installing a runtime or stopping
an existing service. If that requires administrator permission, setup stops with a recovery command.

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
  attributed to the styal executable, or deny access without a prompt. If agent work fails to
  read those folders, grant Full Disk Access to the executable listed in the launch agent's
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

If your background service uses an older npm-based launcher, migrate it once on the
host using an exact released styal version:

```sh
npx @styal/cli@<version> service update
```

This installs the styal executable archive and replaces the service launcher. Existing styal
threads, settings, and projects stay in the same data directory. If you use a
custom data directory, pass the same `--base-dir` you used before. Older package
installs are retained; the new launcher uses a separate runtime directory. This
migration requires a restart. A remote update reports the exact local migration
command instead of attempting an incompatible launcher switch.

For a foreground process, stop your existing server after active work finishes,
then start `npx @styal/cli@<version> serve` with your existing startup options.

Containers without systemd or launchd should run `styal serve` under the container's
process supervisor. The CLI does not install a service manager.

## Troubleshooting

Run `styal service status` on the server machine. An installed version alone does not mean the service
is running or will survive logout. Linux status reports these problems:

| Code                       | What it means                                                                    | Recovery                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `linger-disabled`          | The service stops after your last login session ends and does not start at boot. | Run `sudo loginctl enable-linger "$(id -un)"`, then retry setup as your normal user.                                                       |
| `linger-unavailable`       | styal could not verify the logout setting.                                       | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                                         |
| `user-manager-unavailable` | styal cannot reach your systemd user manager.                                    | Run `systemctl --user status` in a login session for the service user. Install your distribution's systemd user-session support if needed. |
| `service-disabled`         | The service is not enabled to start automatically.                               | Run the repair command shown by `styal service status`.                                                                                    |
| `service-stopped`          | The service is installed but is not running.                                     | Read the service log and `systemctl --user status styal.service`, then run the displayed repair command.                                   |

For an SSH host, run the administrator command in an interactive terminal so sudo can prompt for
your password:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Run only the `loginctl` command with sudo. Running `styal` with sudo creates a separate installation and
styal Link identity for root. If an administrator is unavailable, run `styal serve` in a terminal and
keep that session open.

Setup leaves an existing service running if the user-manager or lingering check fails.

`styal service status` prints the log path. The adjacent `server.trace.ndjson` file contains detailed
server traces. For failures after authorization, see [styal Link troubleshooting](./remote-access.md#styal-link-troubleshooting).
