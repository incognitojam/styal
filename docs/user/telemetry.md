# Product usage data

The styal server sends product usage events to styal's own PostHog project on PostHog EU Cloud,
associated with a hashed account or installation identifier. They do not go to T3 Code's analytics.
To count installations and their owners, events also carry a stable hashed installation ID. The server reports hashed styal Link, OpenAI and Claude account identifiers when signed in, and hashed random identifiers for client devices that connect.
Events include the provider, model, reasoning effort, permission mode, turn and request results,
duration, how many approval requests the turn raised, how many actions Codex's Auto reviewer
approved or denied, the build's release channel, and token counts when available. Child-agent token
counts are reported separately from the main agent's. Model names are sent only when they appear in
a provider's public model list. Approval and review counts never include the command or file
involved.

When a device stream that showed video for at least five seconds closes, web, desktop and mobile viewers report its platform, video format, whether the server was on the same machine, its length, average frame rate, and counts of decoder resets, reconnects and pauses with the largest pause and delay. Device names, identifiers, addresses and images are not collected.

Once after startup and then daily, the server reports each configured provider: its type, whether
it is the default or an added instance, whether it is installed, enabled and healthy, its version
and the newest version styal has tested, how it was installed (such as npm or Homebrew), and whether automatic updates are on, could update
it, or were held back by threads using that provider. Each provider update you start, or that styal installs in
the background, records the provider type, its versions before and after, whether it succeeded, a
fixed failure category, and how long it took. Instance names, installation paths, update commands,
installer output, and error messages are not collected.

When a turn triggers an inactivity warning, the server reports the provider type, whether the
delay happened during startup or after attachment, how long it was quiet, and when the warning
clears because activity resumed, work or a request appeared, or the turn ended. Thread and
session identifiers, prompts, output, commands, and paths are not collected. Local incident
records remain in the activity log even when telemetry is disabled.

The server also counts when someone uses a feature from any client, such as launching, forking or pinning a thread, rolling back a checkpoint, changing a thread's permission or interaction mode, opening a terminal, preview or editor, creating a worktree, running a git or pull request action, saving or running a scheduled task, cloning a project, publishing a repository or customizing a keybinding. Where a feature has options, the choice is recorded from a fixed list, such as the editor or worktree strategy. Paths, titles, branch names, messages and other text are not collected.

Failed calls to styal's tools and successful calls that hand off work record the tool's name, the provider type of the calling agent, whether the call succeeded with a fixed error code when it failed, and how long it took. When the tool hands work to another thread, such as delegating a task, launching a thread or sending it a message, the event also records settings the agent chose, such as the workspace type or how many threads it started, and the provider type, model and modes of each agent involved. When a delegated task finishes, its final status, both agents' provider types and models, and its run time are recorded. Models are recorded only when they come from a provider's published list, not models you added yourself or from tools like OpenCode that list your own configuration. Provider instance names, thread identifiers, prompts, titles and tool arguments are not collected.

Usage events do not include prompts, responses, file contents, authentication tokens, conversation
IDs, raw provider events, or child-agent output.

Web, desktop, and mobile clients also summarize how each connection to a remote server behaved while
the app was open: time connected and reconnecting, drops and their cause, failed connection
attempts, how long reconnecting took, switches between ways of reaching the server, heartbeat
round-trip times, and the amount and peak rate of data received and sent. Each summary names the
network type, such as Wi-Fi or cellular, and how the client reached the server, such as styal Link,
LAN, or Tailscale. It does not include network or carrier names, IP addresses, or location. Each
server receives only the summaries of its own connections and sends them as usage events. The mobile
app keeps its own copy in **Settings → About → Diagnostics** either way.

To disable product events, set `T3CODE_TELEMETRY_ENABLED=false` in the server's environment before
starting it. This stops product events from being recorded or sent. Test and CI processes default
to product event collection disabled; `T3CODE_TELEMETRY_ENABLED=true` explicitly enables it. The web
app in a browser, including one the `styal` CLI opens, does not read this variable.
To send events to your own PostHog project instead, set `T3CODE_POSTHOG_HOST` and
`T3CODE_POSTHOG_KEY`.

## Error reports

Release builds also report server errors so maintainers can find and fix bugs. A report contains
the error type and message, the stack trace, and the operation that failed, with the same
identifier and version details as usage events. Before sending, the server replaces your home
directory and user names in paths, replaces folder and file names in paths under your home
directory, mounted volumes, temporary folders, network shares, and Windows drives (keeping file
extensions and hidden folders such as `.styal`), and removes email addresses,
credentials in URLs, query strings, and long token-like values. An error message can still quote
part of what the failing operation was handling, such as a relative file path or a line of command
or provider output. Other details the server logs alongside an error are not sent.

To stop error reports while keeping usage events, set `T3CODE_ERROR_REPORTING_ENABLED=false`.
Disabling telemetry with `T3CODE_TELEMETRY_ENABLED=false` stops both.

An administrator can turn product events and relay tracing off for every user on a machine with
a [managed policy](./managed-policy.md#other-capabilities).

The desktop app reads `T3CODE_TELEMETRY_ENABLED` from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and thread titles, model
names, activity status, and environment and thread identifiers to the styal Link relay for
[mobile notifications and live activities](./mobile-notifications.md). This is separate from
usage events and error reports. The telemetry opt-out does not disable it.

To stop publishing, turn off **Publish agent activity** under **Settings > Sharing & access** on
the host. Turning off notifications on a phone controls that phone's alerts, not the host's
publishing setting.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
