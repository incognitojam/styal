# Product usage data

The T3 Code server sends product usage events to PostHog, associated with a hashed account or
installation identifier. Events include the provider, model, reasoning effort, permission mode,
turn result, duration, and main-agent token totals when available.

Agent browser usage includes the operation name, whether it succeeded, failed, or was cancelled,
and its duration. It does not include visited URLs, page content, screenshots, selectors, typed
input, or evaluated code. Creating a browser tab explicitly also records a manual browser-session
event. Device panel actions and agent device tools record their operation and outcome, whether the
device is local or remote when known, and its platform when reported. Device names, identifiers,
screenshots and action arguments are not collected.

Usage events do not include prompts, responses, file contents, authentication tokens, conversation
IDs, raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

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
