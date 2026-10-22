# Product usage data

The T3 Code server sends product usage events to PostHog, associated with a hashed account or
installation identifier. Events include the provider, model, reasoning effort, permission mode,
turn result, duration, how many approval requests the turn raised, how many actions Codex's Auto
reviewer approved or denied, and main-agent token totals when available. Approval and review
counts never include the command or file involved.

Agent browser usage includes the operation name, whether it succeeded, failed, or was cancelled,
and its duration. It does not include visited URLs, page content, screenshots, selectors, typed
input, or evaluated code. Device panel actions and agent device tools record their operation and
outcome, whether the device is local or remote when known, and its platform when reported. Device
names, identifiers, screenshots and action arguments are not collected.
Hardware tools and the hardware lease controls in Settings and the thread header record their
operation, its outcome, and for an agent's device call the action's access tier. Device names,
addresses, action names, arguments, responses and uploaded files are not collected, and calls
scripts make through a lease's proxy are not recorded.
Agent workflow run watches record whether each watch or unwatch call started, stopped, or
found a run already finished, and how each watch ended: the run's conclusion, a failure to read
it, or being stopped, with how many minutes it was watched. Repositories, run links, and workflow
or job names are not collected.

Once after startup and then daily, the server reports each configured provider: its type, whether
it is the default or an added instance, whether it is installed, enabled and healthy, its version
and the newest version styal has tested, how it was installed (such as npm or Homebrew), and whether automatic updates are on, could update
it, or were held back by threads using that provider. Each provider update you start, or that styal installs in
the background, records the provider type, its versions before and after, whether it succeeded, a
fixed failure category, and how long it took. Instance names, installation paths, update commands,
installer output, and error messages are not collected.

Once after startup and then daily, the server also reports the current values of its settings, so
we can see which defaults people change: on/off settings, chosen options such as the default permission mode, and day or minute
counts. Paths, branch prefixes, instructions, model choices, and per-project settings are not
collected; for those it reports only whether they were changed or how many projects have their own
settings.

Web and desktop clients also record explicit diff-order selections, when you open a
mentioned time's explanation, which automatic settling rules you keep when finishing setup, when
you change the sidebar's project filter or start a thread while it is applied, whether a project
action you run is saved in styal or comes from the project's `styal.json`, and whether the project
has a `styal.json`, a `t3.json` or neither. The web app records when a new-build notice is visible and
when you choose Refresh. The desktop app records when its notice
naming the version it updated to is shown and when you open that version's release notes. These events use the relevant paired environment's telemetry setting.
File paths, written times, deployment identifiers, project names, action names and commands, and composer drafts are not collected.

Each automatic thread settlement records its rule (a merged or closed pull request, or inactivity with the configured number of days), and un-settling a thread records which of those rules, or a manual settle, had settled it. Thread titles, pull request numbers and links are not collected.

On macOS, the desktop app records how long after an update was ready the computer first sat idle or locked with no threads waiting on you, as a rough range, so we can learn whether installing updates while you are away would work. It does not record when you were idle, what you were doing, or any thread details.

Pull request deployment controls record whether someone opens an environment, opens deployment logs, or expands the environment list, and whether the action succeeded. Environment names, URLs, repositories, pull request numbers, and commit hashes are not collected.

Usage events do not include prompts, responses, file contents, authentication tokens, conversation
IDs, raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

Web, desktop, and mobile clients also summarize how each connection to a remote server behaved while
the app was open: time connected and reconnecting, drops and their cause, failed connection
attempts, how long reconnecting took, switches between ways of reaching the server, heartbeat
round-trip times, and the amount and peak rate of data received and sent. Each summary names the
network type, such as Wi-Fi or cellular, and how the client reached the server, such as styal Link,
LAN, or Tailscale. It does not include network or carrier names, IP addresses, or location. Each
server receives only the summaries of its own connections and sends them as usage events. The mobile
app keeps its own copy in **Settings → About → Diagnostics** either way.

To disable collection, set `T3CODE_TELEMETRY_ENABLED=false` in the server's environment before
starting it. This stops product events from being recorded or sent. Test and CI processes default to
collection disabled; `T3CODE_TELEMETRY_ENABLED=true` explicitly enables it.

## Error reports

Release builds also report server errors so maintainers can find and fix bugs. A report contains
the error type and message, the stack trace, and the operation that failed, with the same
identifier and version details as usage events. Before sending, the server replaces your home
directory and user names in paths, and removes email addresses, credentials in URLs, query strings,
and long token-like values. An error message can still quote part of what the failing operation
was handling, such as a file name or a line of command or provider output. Other details the server
logs alongside an error are not sent.

To stop error reports while keeping usage events, set `T3CODE_ERROR_REPORTING_ENABLED=false`.
Disabling telemetry with `T3CODE_TELEMETRY_ENABLED=false` stops both.

The desktop app reads the variable from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > General > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
