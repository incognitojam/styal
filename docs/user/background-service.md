# Running styal in the background

On Linux and macOS, styal can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Run these commands on the machine that will host styal:

| Task                            | Command                                    |
| ------------------------------- | ------------------------------------------ |
| Install and start               | `npx @styal/cli@nightly service install`   |
| Inspect status and log location | `npx @styal/cli@nightly service status`    |
| Update to a newer release       | `npx @styal/cli@nightly update`            |
| Repair                          | `npx @styal/cli@nightly service install`   |
| Stop and remove from startup    | `npx @styal/cli@nightly service uninstall` |

Uninstalling the service leaves your projects, threads, and settings intact.

`service install` uses the version of the CLI you invoke. `update` installs the
newest release on your channel and updates the service; pass an exact version,
such as `update 1.2.3`, to pin one. Both refuse to replace a newer service with an
older version unless you explicitly add `--allow-downgrade`.

Updating restarts the server. Finish active work first, and wait for any remote
update already in progress. Run local service commands in a separate terminal or
SSH session, because restarting the service can close terminals opened inside
styal. To match a remote client's version, follow [Updating styal](./updating.md).

Containers without systemd or launchd should run `styal serve` under the
container's process supervisor. The CLI does not install a service manager.

## Local network access

The service listens on your local network and Tailscale addresses, so the
desktop and mobile apps on the same network connect directly instead of through
styal Link. The hosted web app at app.styal.build stays on styal Link, because
browsers block plain HTTP from an HTTPS page. The service does not answer on
public addresses, and every device still needs to pair or sign in. To keep the service reachable from this machine only, set
`T3CODE_HOST=127.0.0.1` in `service.env` (below). Any `T3CODE_HOST` value
replaces this default.

## Configure the service environment

Put custom environment variables in `service.env` under the service's styal
home directory, normally `~/.styal/service.env`. This file survives service
installation, updates, and uninstalling the service. For example:

```dotenv
T3CODE_PORT=3773
T3CODE_HOST=127.0.0.1
```

Use `KEY=VALUE` entries, quoting values that contain spaces or `#`. Values are
literal: shell commands and variable expansion are not evaluated. Entries
override the inherited service environment, except for `PATH`, `STYAL_HOME`,
`T3CODE_HOME`, `T3_BOOT_SERVICE_UNIT`, and `T3_SERVICE_LAUNCHER_CONTEXT`
(including case variants).

Run `styal service restart` after changing the file. Changes apply when the
service starts again; switching the server version alone keeps the current
values. For a service installed before env-file support, run
`styal service install` once with an up-to-date CLI.
A missing file is ignored; other read failures stop service startup.
If the file contains credentials, restrict access to that file with `chmod 600`
(for the default styal home, `chmod 600 ~/.styal/service.env`).

## Platform support

Linux needs systemd user services. Setup enables lingering so styal starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

styal Link can offer service installation during setup, but the two are managed
separately. Signing out of styal Link does not stop or uninstall the service.

## Migrating an existing styal installation

If your background service uses an older npm-based launcher, migrate it once on
the host using an exact released styal version. The update notice for that server
shows this command:

```sh
npx @styal/cli@<version> service update
```

This installs the styal executable and replaces the service launcher, which
restarts the service. Threads, settings, and projects stay in the same data
directory. If you use a custom data directory, pass the same `--base-dir` you
used before.

For a foreground server, let active work finish, then follow
[Update a connected server](./updating.md#update-a-connected-server).

## Troubleshooting

Start with `styal service status` on the host. It prints the log path and, on
Linux, checks whether the installed service is running, enabled, and allowed to
survive logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running styal as root creates a separate installation and styal Link
identity. Without administrator access, run `styal serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status styal.service`, then use the repair command printed by styal.                        |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the styal executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/build.styal.app.service.plist`.

For failures after signing in to styal Link, see
[connection troubleshooting](./t3-connect-troubleshooting.md).

## Reclaim database space

styal removes superseded internal history on its own while it runs; your
conversations are kept. Databases created before this shrank automatically
still hold the freed space on disk until a one-time offline repair returns it
and turns on automatic shrinking. Settings > Storage (web and desktop) or
Settings > Maintenance (mobile) suggests the repair when at least 1 GiB can be
reclaimed.

Run `styal doctor` on the machine that hosts the environment. It reports the
database size and the space it can reclaim, then asks which repairs to run;
pass `--fix` to run the recommended ones without a prompt (for scripts), or
`--dry-run` to only report. An installed background service for the same data
directory is stopped for the repair and started again afterwards, also when
the repair fails. Quit a server you started by hand, or the desktop app, first:
the repair refuses to touch a database that is in use. Use `--base-dir` for a
different data directory.

The repair can take several minutes on a large database. It rebuilds the
database through a temporary copy, so it needs free space of about the
database's size twice over: once in the system temporary directory (`TMPDIR`
or `/tmp` on Linux and macOS) and once next to the database for its
write-ahead log.

If you upgraded from a version before 0.1.0, its database (`state.sqlite`) is
still kept next to the current one so you can roll back. `styal doctor` offers to
delete it, but never selects that repair for you and `--fix` skips it: once it
is gone, a version before 0.1.0 starts with no threads or settings.
