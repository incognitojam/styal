# Product analytics

The server owns analytics delivery, opt-out, and identity for every connected client.
Clients do not load the PostHog browser SDK. Client-use events require an
authenticated connection, so visiting the hosted app without connecting does not
count as product use.

## Installs and owners

`distinct_id` keeps the rule every build has used: the hashed Codex workspace,
else the Claude machine id, else the install's anonymous id. It can change when
someone logs in, and a Codex Team shares one, but keeping it means PostHog charts
and history never break. Do not change it; add a field instead.

Every event also carries `installId` when the server can save its state: the hash
of a random id in the state directory, which never changes for the install. If
that file cannot be written, events still go out under `distinct_id`, as before. Count installs
with it. Who an install belongs to is a separate fact, sent as
`install.owner_observed`. Owners are resolved at query time in our own store, so
a rule can change and apply to all history.

[Owner sources](../../apps/server/src/telemetry/Identify.ts), strongest first:
styal Link, then the OpenAI and Claude person ids, then the client device. The
server reports what it can read itself: the linked Connect account and provider
logins. A connecting client reports its signed-in Connect account and its device,
which links every environment opened from one phone, browser, or desktop. Use the
OpenAI `user_id` claim, not the Codex `account_id` (the ChatGPT workspace, which a
whole Team shares) or the token `sub` (one per login method). Two Connect accounts are never the same person, whatever
weaker ids they share.

Every id is SHA-256 hashed with [one helper](../../packages/shared/src/telemetryId.ts)
on both sides, so a Connect account hashes the same on the client and the server.
The server accepts only hashes from clients.

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

Use `client.turn.requested` for active-use reports. There is no connection event,
because styal Link sessions expire hourly and each reconnect would count again.
A command whose id was already accepted is a retry, so it records nothing again.
One identity can appear in several client groups during a period; adding those
groups double-counts users.

Thread lifecycle events (`client.thread.settled`, `unsettled`, `archived`,
`unarchived`, and `deleted`) record accepted commands. `client.thread.settled`
counts only explicit settles; the server records its automatic settles as
`server.thread.settled` (see [Feature usage](../operations/feature-usage.md#thread-settle-reasons)).

`client.network.report` summarizes up to 15 minutes of foreground use of one
environment on one network type and route. Its event time is when the window
ended, so reports a client could only send after a dead zone land in the period
they describe. Aggregate by `networkKind` and `routeKind`, weighting by
`durationMs`: availability is summed `connectedMs` over summed `durationMs`.
Per-window round-trip percentiles cannot be combined into an overall percentile;
reconnect times can, because `recoveryMs` lists each recovery's duration.
`drops` counts sessions that failed after answering in the foreground. A socket
the operating system closed while the app was in the background is found on
return; it appears as `initialConnectMs` instead, so every resume does not read
as a network failure. The `drops*` cause fields sum to `drops`:
`dropsStoppedResponding` means the client closed the socket after heartbeats went
unanswered, `dropsDisconnected` that the socket closed, and `dropsProbeFailed`
that a health check timed out. `setupTimeouts` is the share of
`failedAttempts` that ran out of time before the session was ready.
`routeSwitches` counts sessions replaced on a different route without a failure,
usually by a better route, and `routeSwitchBacks` counts returns to the route
left by a switch after the switched-to session failed. Both land in the window
of the route switched to.
A send whose response was lost is repeated, so rare duplicates are possible.
Byte counts are payload sizes before WebSocket compression, and text frames count
UTF-16 code units.

Provider send and completion counts need not match. Most completions start
without a person: provider continuations, agent sends, and delegated subagents.
`provider.turn.completed` carries the starting message's `createdBy` and
`creationSource`, plus `scheduled` and `subagent`; filter on them to count user
turns. Collection is best effort, with no scan or backfill of provider history.

Token totals cover the main agent. Child agents and model rerouting prevent a turn
from representing one provider/model combination's full cost. For provider
comparisons, require complete usage, no observed subagents, and no mixed models;
compare matching model, effort, interaction mode, and terminal status. Aggregate
output/input ratios should divide the summed totals. Averaging per-turn ratios
lets small-input turns dominate.

Unknown counts stay absent. Partial usage contains valid observed counts but
cannot establish a whole-turn total. Keep these distinctions when changing token
normalization or building reports.

`feature.used` counts WebSocket requests that start a feature. RPCs are observed in
the RPC authorization middleware after the request succeeds; dispatched commands
are recorded by the dispatch handler, which can tell a retry apart.
[Feature mapping](../../apps/server/src/telemetry/FeatureUsage.ts) allowlists
the methods and commands, and takes variants only from closed contract enums,
so paths, ids, and text never reach analytics.

Agent tool events report driver kinds, never instance ids: users name
instances, so an instance id can identify an account or employer.
[Provider dimensions](../../apps/server/src/telemetry/ProviderDimensions.ts)
report a model only when it is a non-custom entry in a vendor catalog. OpenCode,
Pi, and ACP agents list models from user configuration, such as local Ollama
tags, so their models stay out. Handoff settings come from closed enums and
booleans in tool arguments; prompts, titles, and ids are never read. Thread ids
are used only to look up the threads on each side and never leave the server,
which is also why tool events carry no per-thread sequence. A handoff to several
threads, such as `create_threads`, records one `mcp.tool.invoked` per target, each
repeating the call's outcome and duration, so event counts are not call counts.

## Delivery

The server sends batches straight to PostHog's batch endpoint, the styal project on
PostHog EU Cloud unless `T3CODE_POSTHOG_HOST` and `T3CODE_POSTHOG_KEY` point it
elsewhere. Upstream builds send to T3 Code's `ingest.t3.codes` proxy instead; the
fork must never default to it. A send can fail after PostHog has stored the batch,
so every retry is a copy.
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

Dev-runner servers and the CI archive smoke test turn telemetry off, which also
stops relay tracing, because each would count as a new install. Set
`T3CODE_TELEMETRY_ENABLED=true` to test analytics or relay tracing from a dev server.
