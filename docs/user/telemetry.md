# Product usage data

The T3 Code server sends product usage events to PostHog, associated with a hashed account or
installation identifier. Events include the provider, model, reasoning effort, permission mode,
turn result, duration, and main-agent token totals when available.

Agent browser usage includes the operation name, whether it succeeded, failed, or was cancelled,
and its duration. It does not include visited URLs, page content, screenshots, selectors, typed
input, or evaluated code. Device panel actions and agent device tools record their operation and
outcome, whether the device is local or remote when known, and its platform when reported. Device
names, identifiers, screenshots and action arguments are not collected.
Agent workflow run watches record whether each watch or unwatch call started, stopped, or
found a run already finished, and how each watch ended: the run's conclusion, a failure to read
it, or being stopped, with how many minutes it was watched. Repositories, run links, and workflow
or job names are not collected.

Web and desktop clients also record explicit diff-order selections and when you open a
mentioned time's explanation. The web app records when a new-build notice is visible and
when you choose Refresh. These events use the relevant paired environment's telemetry setting.
File paths, written times, deployment identifiers, and composer drafts are not collected.

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
