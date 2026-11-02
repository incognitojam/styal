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

Provider send and completion counts need not match. `provider.turn.completed`
is one provider turn, and `segment` says what started it: the run's first
attempt (`initial`), a `steering_restart`, a provider `continuation` such as a
Codex goal turn, or a `native_child` subagent. `createdBy`, `creationSource`,
`scheduled`, and `subagent` describe the run's starting message, and `childKind`
separates native subagents from styal-managed child threads. Use this event for
per-turn measurements, not for counting requests.

`provider.request.completed` is one run, recorded when the run settles in the
server process that ran it. It adds each root turn once, so continuations,
steering, and replayed provider events do not add rows. `requestKind: "user"`
counts what people asked for. Native subagent turns are summed apart from the
root (`childUsageStatus`, `childInputTokens`); styal-managed child threads report
their own requests as `t3_child`. A child still running at settlement is never
added later, and the summary sets `childrenRunning`. A server restart loses the
summary of a run in progress. A run that continues after a restart reports its
own usage with `restartContinuation` and `lifecycleObserved: false`; it cannot
recover the original request's count or kind. A run whose provider session never
opens has no summary, and a start the provider rejects reports
`providerTurns: 0`. A Stop that lands while a steering restart is starting ends
the run without a summary. Collection is best effort, with no scan or backfill of
provider history.

Counts cover the main agent. `otherInputTokens` and `otherOutputTokens` are what
a provider's own ledger recorded beyond it during the turn: Claude's per-process
`modelUsage` growth, which covers native subagents, compaction, and helper
calls. They need a baseline from the same process, so they stay absent when it
is unknown or the ledger goes backwards, and background work that ends between
turns lands in the next one. Claude subagents have no turns of their own, so
this never overlaps child turns.

`model`, `effort`, and `serviceTier` are what the run selected. `serviceTier`
is `standard`, `flex`, `fast`, or `ultrafast`, from Codex's tier option or
Claude's fast mode, and is absent when the selection does not set one. `observedModel` and
`mixedModels` appear only when the provider reported the models for the counted
work (Codex thread settings and reroutes, Claude root messages, OpenCode steps).
`mixedModels: false` without `reportVersion` was never checked. Model labels
come from the bundled model manifest and the Cursor and Grok catalogs, also for
routed ids such as `anthropic/claude-opus-5-5`, and efforts come from a closed
list, so user-configured names stay out.

Status and counters answer different questions. `usageReported: false` means
the adapter attached no usage; a harness where every row says so is unsupported,
not idle. `partial` keeps valid counts that cannot establish a whole-turn total,
such as an OpenCode step that ended without a report, an OpenCode stream
reconnect, or an interrupted segment.
Explicit zeros are sent and unknown counts stay absent. `localCommand` marks a
provider-local command such as Claude's `/compact`, whose result counters are not
model work. Reasoning tokens are a subset of output.

Charts built on these events should say "output tokens per measured provider
completion", compare matching provider, observed model, effort, interaction mode,
and terminal status, and show eligible and measured counts by harness, origin,
and status so unknown models and unsupported adapters stay in the denominator.
Divide summed totals for output/input ratios; averaging per-turn ratios lets
small-input turns dominate. Rows without `reportVersion` keep their missing
fields unknown; a missing origin is never a person.

`feature.used` counts WebSocket requests that start a feature. RPCs are observed in
the RPC authorization middleware after the request succeeds; dispatched commands
are recorded by the dispatch handler, which can tell a retry apart.
[Feature mapping](../../apps/server/src/telemetry/FeatureUsage.ts) allowlists
the methods and commands, and takes variants only from closed contract enums,
so paths, ids, and text never reach analytics. Guests of a shared thread have no
WebSocket connection, so the guest share service records their joins and messages
itself, with no `surface`.

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
