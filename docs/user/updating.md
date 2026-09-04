# Updating styal

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, an update notice appears in the
conversation and **Settings → Connections**. Update the machine named in that
notice.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → General → Continue threads after server updates** is off by default.
Enable it to resume supported active threads once the replacement server is
ready. Terminal commands may still be interrupted.

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

For a foreground server, stop it, then relaunch with
`npx @styal/cli@<client-version> serve`, preserving options such as `--host` or
`--tailscale-serve`. If styal runs under a service or container that you manage
yourself, update it through your existing deployment method. See
[background services](./background-service.md) for service management.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

## Desktop app updates

The desktop app downloads updates in the background and installs them when you
quit, ready for your next launch. On macOS, closing the last window leaves the
app running; choose **Quit** to install. To apply a downloaded update right away,
select **Restart to update** in the sidebar. Update checks, download progress,
retries, and the update track are in **Settings**. Changing the track cancels a
pending update from the previous track.

Before quitting or restarting, styal checks agents and terminal commands in the
environments the desktop app hosts, including WSL and work started from other
devices. If work is active or cannot be checked, styal lists it and lets you
cancel or continue; cancelling keeps the downloaded update. If the confirmation
cannot be displayed and the app stays unresponsive, choose **Quit** again after
five seconds to exit. This can interrupt running work.

## Mobile updates

The mobile app can download updates in the background and apply them when you
next leave the app. It saves drafts and queued messages before restarting. If you
keep the app open for a long time, it may ask to install immediately; choosing
**Later** leaves the update queued for the next suitable moment.
