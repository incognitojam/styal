# Feature usage

styal uses upstream's analytics events and feature counts, delivered to the styal PostHog project with the shared identity and telemetry opt-out. See [Product analytics](../internals/product-analytics.md) for attribution and interpretation, and [Product usage data](../user/telemetry.md) for the collection boundary.

`feature.used` counts successful WebSocket requests and accepted commands from the allowlisted [feature mapping](../../apps/server/src/telemetry/FeatureUsage.ts), with optional contract-enum variants and client surface. Device panel opens, workflow approvals, settles and archives use these counts. `mcp.tool.invoked` follows upstream’s policy: successful handoffs and failed tool calls, including browser, device, hardware, guide, feedback and workflow run watch tools. Handoff and delegated-task events retain upstream's provider and model attribution.

`provider.turn.sent` records successful sends to providers. Turn analytics include Auto mode and Auto reviewer decisions, and provider stall events describe inactivity incidents. Provider instance and update reports describe installed versions, health and update outcomes without configured instance names.

`device.stream.summary` describes a viewer session that showed video for at least five seconds: platform, transport, connection kind, duration, frame rate, decoder resets, reconnects, pauses and delay. It does not include device identifiers, names, addresses or images. The client reporting RPC negotiates its existing vocabulary version; retired reports from older clients are accepted and silently discarded.
