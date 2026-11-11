# Running styal in the background

On Linux and macOS, styal can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Run these commands on the machine that will host styal:

| Task                                  | Command                                    |
| ------------------------------------- | ------------------------------------------ |
| Set up access from your other devices | `npx @styal/cli@nightly up`                |
| See how your other devices reach it   | `npx @styal/cli@nightly status`            |
| Install and start                     | `npx @styal/cli@nightly service install`   |
| Inspect status and log location       | `npx @styal/cli@nightly service status`    |
| Update to a newer release             | `npx @styal/cli@nightly update`            |
| Repair                                | `npx @styal/cli@nightly service install`   |
| Stop and remove from startup          | `npx @styal/cli@nightly service uninstall` |

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

A new service answers only on this machine. Other devices reach it through
styal Link, or directly once you choose the local network in `styal up` (or run
`styal up --lan`, which sets `T3CODE_LAN=true` in `service.env`). It then listens on
your local network and Tailscale addresses, so the desktop and mobile apps on
the same network connect directly instead of through styal Link. It still does
not answer on public addresses. Anyone on the same network can reach the port,
so a pairing code is all that keeps them out. The hosted web app at app.styal.build
stays on styal Link, because browsers block plain HTTP from an HTTPS page.

A service installed before `T3CODE_LAN` existed keeps listening on the local
network. `styal status` says so, and `styal up --no-lan` turns it off. Any
`T3CODE_HOST` value replaces this setting.

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

Windows background services are not supported. To keep a Windows host available
through styal Link, leave the desktop app running with its local environment
enabled, or keep `styal serve` running in a terminal. Minimize the desktop app rather
than closing its last window, which stops its local server. Linking styal Link
does not configure automatic startup at Windows sign-in.

`styal up` installs the service when you set up styal Link, but the two are managed
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

## Keep the server responsive when agents use all memory

On Linux, agents already run with lower priority than the server. When they
fill the machine's memory, though, the kernel may still slow down or stop the
server, because only an administrator can reserve memory for it. Run, as your
normal user:

```sh
styal service protect
```

It shows the system settings it will change, asks before applying them, and
then asks for your sudo password. If the machine runs Tailscale or SSH, it
also offers to protect them, so you can still reach the machine. Memory
protection takes effect at once. The server's protection from the kernel's
out-of-memory killer takes effect after `styal service restart`. `styal service status` reports whether
the protection is in place, and `styal service protect --undo` removes it.

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

Your conversations remain available from the stored history. Databases with
unused space still hold it on disk until a one-time offline repair returns it
and turns on automatic shrinking. Settings > Maintenance (web and desktop) or
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

## Safety copy before history pruning

History pruning is off by default. To turn it on early, start the server with `T3CODE_EVENT_PRUNING=1` in its environment. This also applies to desktop and background-service server processes. Without it, styal makes no pruning copy, checks no copy disk space, and shows no copy progress screen.

Before deleting older internal history events, styal saves a verified copy of `statev2.sqlite` in `backups/pre-event-prune/` beside the database (normally `~/.styal/userdata/backups/pre-event-prune/`). Imported and migrated thread history remains readable after pruning. The first startup can take longer on a disk that cannot clone files: styal copies the database before opening it for normal use, and shows progress while you wait. The copy needs free disk space equal to the database size plus the larger of 1 GiB or 10%. If there is not enough space, styal starts normally without pruning and checks again at the next startup.

You can quit the app or stop the service during the copy. The incomplete copy is discarded, and the next start tries again immediately. If copying stops making progress for a minute or exceeds its size-based limit, styal gives up, starts without pruning, and retries at a startup at least seven days later. A disk-full failure is retried at the next start. Nothing is pruned without a verified copy.

Background-service updates defer the safety copy and pruning until the next ordinary service start after the update finishes. Existing service launchers keep working without a manual launcher update.

The copy stays until a maintenance run at least seven days after the first completed deletion. It stays indefinitely if no deletion completes. After it expires, the manifest stays as the record that the first prune was protected. Pruning continues without making another copy. This recovery copy is not a continuous backup.

To restore it, stop the server and quit the desktop app. Save your current database elsewhere, replace `statev2.sqlite` with the copy from `backups/pre-event-prune/`, and remove `statev2.sqlite-wal` and `statev2.sqlite-shm` beside the restored database if they exist. Start styal again. Everything recorded since the copy was taken is lost when you restore it. Pruning pauses and the recovery copy does not expire while you verify the restored history, including when the copy was taken after an earlier prune. Pruning also pauses if styal cannot verify that an existing recovery copy belongs to the current database. Once you are happy with the restored database, stop styal, delete `backups/pre-event-prune/`, and start it again to make a new safety copy and resume pruning.

If an unused copy belongs to a different database generation and neither records a deletion, styal safely replaces it at the next startup. If either the database or the copy records a deletion and their generations differ, styal preserves the copy, warns, and pauses pruning. Keep that copy until you have verified which database you want to retain; removing `backups/pre-event-prune/` and restarting explicitly requests a new copy of the current database.
