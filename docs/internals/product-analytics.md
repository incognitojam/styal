# Product analytics

The server owns PostHog delivery, opt-out, and identity for every connected client.
[Identity selection](../../apps/server/src/telemetry/Identify.ts) hashes an available
provider account ID, falling back to an installation-scoped ID. This identity can
span several clients; it does not identify a browser session. Clients do not load
the PostHog browser SDK. Client-use events require an authenticated connection, so
visiting the hosted app without connecting does not count as product use.

Styal builds send events to the Styal PostHog project in the EU Cloud region by
default. Set `T3CODE_TELEMETRY_ENABLED=false` on the server process to disable
collection. `T3CODE_POSTHOG_KEY` and `T3CODE_POSTHOG_HOST` may be overridden for
development or self-hosted PostHog installations.

## Attribution boundaries

Client dimensions belong to the event's WebSocket connection. A server-global
"current client" would misattribute simultaneous web, desktop, and mobile use.
Provider execution has its own events because a turn can outlive the requesting
connection.

Keep client and server dimensions separate. A desktop host can serve a phone or a
remote browser, and a direct connection can cross a network. Older clients omit
metadata. Missing client values must stay unknown rather than being backfilled
from server properties. The legacy `clientType` property describes how the server
runs; use `surface` for the connected client.

## Interpreting events

Use `client.turn.requested` for active-use reports. `client.connected` counts
reconnects, so network behavior can inflate it. One identity can appear in several
client groups during a period; adding those groups double-counts users.

Thread lifecycle events (`client.thread.settled`, `unsettled`, `archived`,
`unarchived`, and `deleted`) record accepted commands. `client.thread.settled`
counts only explicit settles; settled states a client derives from inactivity or a
merged pull request do not emit it.

Provider send and completion counts need not match. Providers can emit synthetic
turns without a send request. Collection is best effort, with no scan or backfill
of provider history.

Token totals cover the main agent. Child agents and model rerouting prevent a turn
from representing one provider/model combination's full cost. For provider
comparisons, require complete usage, no observed subagents, and no mixed models;
compare matching model, effort, interaction mode, and terminal status. Aggregate
output/input ratios should divide the summed totals. Averaging per-turn ratios
lets small-input turns dominate.

Unknown counts stay absent. Partial usage contains valid observed counts but
cannot establish a whole-turn total. Keep these distinctions when changing token
normalization or building reports.

## Delivery

A send can fail after PostHog has stored the batch, so every retry is a copy.
[Delivery](../../apps/server/src/telemetry/AnalyticsService.ts) gives each event a
uuid when it is recorded, backs off after a failed send, and drops a batch after a
few tries. Without these limits, one stuck batch was sent every second for days.

## Error reports

[Error reporting](../../apps/server/src/telemetry/ErrorReporting.ts) turns every Error
or Fatal log entry into a `$exception` event and sends it through the analytics
delivery path, so it shares identity, opt-out, and retries. Logging at Error level
is therefore a report to maintainers: use it for states that indicate a bug, and
log expected failures, such as a missing binary or a user's invalid input, at
Warning or below. Effect does not log fibers that fail unhandled, so a defect is
reported only where something logs it; RPC handler defects are logged by
[RPC instrumentation](../../apps/server/src/observability/RpcInstrumentation.ts).

Release CI uploads server source maps with PostHog's bundler plugin, which stamps
each chunk with a chunk id that the reporter attaches to that chunk's frames.
Only bundles built with the upload resolve: a frame from any other build, or from
a chunk bundled outside `apps/server/vite.config.ts`, reaches PostHog unresolved.
See [release credentials](../operations/release.md#server-source-maps-for-error-tracking).

Reports carry only the thrown value and the log message. Log annotations and
message objects stay local because they often hold prompts, paths, or
configuration. Only release builds report by default; development servers set
`T3CODE_ERROR_REPORTING_ENABLED=true` to test delivery.

## Collection boundary

Keep analytics payloads to product metadata and normalized measurements. Do not
send prompts, authentication material, raw provider payloads, user-assigned device
names, or conversation identifiers. Client metadata is best effort; invalid values
must not reject a connection. PostHog person profiles remain disabled.
