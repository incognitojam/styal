# Feature usage

`feature.used` events use the existing PostHog identity, delivery queue, and telemetry opt-out. Start with `feature = browser-tools` and `source = agent`; other features need explicit instrumentation before their absence means anything. This does not measure manual Browser panel use.

For adoption, count distinct reporting identities that successfully perform an action, excluding `status` probes. Compare them with distinct identities with `provider.turn.completed` in the same period. Restrict both cohorts to `featureUsageVersion = 1`, and intersect the feature cohort with the active cohort. The version property is attached to every analytics event, so earlier installations cannot silently enter the denominator. Keep the release/version breakdown when comparing periods across rollout.

This estimates adoption among active reporting identities, not every user. Telemetry opt-outs are absent, the identity may represent an account or an installation, and some active environments have no compatible desktop browser host. A low rate is evidence to investigate availability and discoverability before removing a feature. Track failed attempts separately from successful adoption; an unavailable feature can have demand without successful uses.

For reliability, include every action and outcome, then break down failures and p50/p95 `durationMs` by action and server version. Browser snapshot outcomes include saving a requested screenshot, and recording-stop outcomes include transferring its artifact. Internal status requests for tool icons do not emit additional usage events.

To add another feature, extend the fixed vocabulary in `apps/server/src/telemetry/FeatureUsage.ts` and observe its public operation once at the owning entry point. Include each applicable manual and agent entry point before interpreting the count as whole-feature adoption. Send structural metadata only; never pass operation arguments, results, names, URLs, paths, selectors, page content, or screenshots.

Run the real Electron viewport check with `vp run --filter @t3tools/desktop test:preview-calibration` from the repository root. `.scratch/` must be ignored. CI runs it on Linux and macOS and uploads its synthetic snapshots and measurements. It exercises the production viewport calculation, native webview, snapshot capture, and locator input; MCP transport and the complete renderer/IPC wiring remain covered separately.
