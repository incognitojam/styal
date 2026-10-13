# Product usage data

The T3 Code server sends product usage events to PostHog, associated with a hashed account or
installation identifier. Events include the provider, model, reasoning effort, permission mode,
turn result, duration, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

To disable collection, set `T3CODE_TELEMETRY_ENABLED=false` in the server's environment before
starting it. This stops product events from being recorded or sent.

## Error reports

Release builds also report server errors so maintainers can find and fix bugs. A report contains
the error type and message, the stack trace, and the operation that failed, with the same
identifier and version details as usage events. Before sending, the server replaces your home
directory and user names in paths, and removes email addresses, credentials in URLs, query strings,
and long token-like values. Other details the server logs alongside an error are not sent.

To stop error reports while keeping usage events, set `T3CODE_ERROR_REPORTING_ENABLED=false`.
Disabling telemetry with `T3CODE_TELEMETRY_ENABLED=false` stops both.
