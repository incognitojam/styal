# Run commands in the terminal

In the web and desktop clients, shell code blocks in completed agent replies include a **Run in
terminal** action alongside the line-wrap and copy actions. Review the command, then select the
terminal action to open the thread's terminal and run it from the thread working directory.

T3 Code reuses the active terminal when it is idle. If that terminal has a running process, it opens
a new terminal so the command does not get typed into the existing process. The action only appears
for recognized shell fences such as `sh`, `bash`, `zsh`, and `powershell`; source-code and plain-text
blocks remain copy-only.

![A shell code block with the Run in terminal action](./images/run-command-code-block-after.png)

# Open terminal links in Preview

Commands run in a T3 Code terminal can open their browser target in the desktop Preview. This
includes development servers that support flags such as `--open`, whether they honor the standard
`BROWSER` environment variable or use the normal macOS or Linux URL launcher. A T3 Code server
started from a T3 Code terminal takes the same path, so the pairing URL it opens at startup arrives
in Preview.

T3 Code opens the requested HTTP or HTTPS URL in the Preview panel for that terminal's thread. For
a remote environment, loopback URLs such as `http://localhost:5173` are resolved against that
environment instead of the desktop machine.

If no compatible desktop Preview is connected, T3 Code delegates the request to the server
machine's normal system browser. An explicitly configured `BROWSER` value is always preserved,
including values such as `BROWSER=none`. Explicit launcher options such as `open -a Safari` also
keep using the system launcher.

## Troubleshoot browser opening

T3 Code does not add `BROWSER` to your global shell configuration. It injects browser-opening
support into each terminal it creates.

In a newly created T3 Code terminal, inspect the browser-opening environment with:

```sh
env | grep -E '^(BROWSER|T3CODE_TERMINAL_BROWSER_OPEN_)='
command -v xdg-open
```

Unless you configured `BROWSER` yourself, the first command should show `BROWSER` and the related
`T3CODE_TERMINAL_BROWSER_OPEN_*` values. On macOS and Linux, the launcher command should resolve to
a T3 Code helper directory. The exact paths vary by installation.

If those values are missing:

1. Close the terminal and create a new one. Existing terminals do not gain environment changes
   from an app or server update.
2. Confirm that the T3 server which owns the environment is up to date. Updating only the desktop
   or web client does not update a remote server, and running newer T3 Code source inside a terminal
   does not update the parent server that created it. See [Keeping app and server in sync](./updating.md).
3. Check the server output for `failed to install terminal browser-open helper`. Normal local
   launches write human-readable logs to their standard output and completed traces to
   `~/.t3/userdata/logs/server.trace.ndjson`. An SSH-managed launch also writes its output under
   `~/.t3/ssh-launch/<state>/server.log`.

If `BROWSER` shows a value you configured, T3 Code deliberately preserves it and does not install
its own launcher variables. Remove or change that setting only if you want terminal browser opens
to use Preview.

When the T3 helper is active, Linux does not need a system `xdg-open` command to route an HTTP or
HTTPS URL to a connected desktop Preview. A real system browser launcher is still required for the
fallback behavior when no compatible Preview is connected.
