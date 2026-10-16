# Feature usage

Monitor [Styal Feature Usage & Browser Health](https://eu.posthog.com/project/120501/dashboard/1026404) in PostHog. It includes adoption, daily rollout coverage, calls by action, outcomes, and successful-call latency by action and server version. Its default date range is 30 days; the date selector applies to every insight.

The dashboard reports adoption as unavailable until it sees an instrumented active cohort. Empty browser charts before the instrumentation ships are expected. Use common metadata filters such as server version or platform; filtering on browser-only properties such as action or outcome removes the active-turn denominator and invalidates adoption.

`feature.used` events use the existing PostHog identity, delivery queue, and telemetry opt-out. The existing browser dashboard filters `feature = browser-tools` and `source = agent`, so adding other feature events does not change its meaning.

Additional measured operations are:

- `devices`, `source = user`: Device panel open, close, shutdown and device actions from a client that reports its surface. Requests forwarded from another environment and older clients without a surface remain unattributed instead of being counted again as manual use.
- `devices`, `source = agent`: public list, open, close and screenshot tools, including failed selection and unavailable hosts. Agent-device CLI interactions are not measured. Exclude discovery (`list`) and cleanup (`close`/`shutdown`) when reporting successful adoption; use `open`, `snapshot` and deliberate device actions. Failure reasons are bounded categories, never error messages.

`browserToolsUsageVersion` and `deviceUsageVersion` identify server instrumentation separately. They indicate collection support, not feature availability or compatible client coverage. Keep the legacy `featureUsageVersion = 1` filter only for the existing agent-browser cohort. Do not interpret a missing event from an older client or an unavailable device host as non-use.

`buildKind` distinguishes release, development and test processes. Release workflows stamp the bundle explicitly; a local build is development even when its package version resembles a release. `releaseChannel` is stable, nightly, preview or unknown. Test and CI processes default to telemetry disabled; opt-in verification must point at a local collector or a separate analytics project, not the production project.

For the existing agent-browser adoption chart, count distinct reporting identities that successfully perform an action, excluding `status` probes. Compare them with distinct identities with `provider.turn.completed` in the same period. Restrict both cohorts to `featureUsageVersion = 1`, and intersect the feature cohort with the active cohort. For new feature comparisons, use the corresponding instrumentation version on both cohorts and filter `buildKind = release`. The version properties are attached to every analytics event, so earlier installations cannot silently enter the denominator. Keep the release/version breakdown and compatible-client limitations when comparing periods across rollout.

This estimates adoption among active reporting identities, not every user. Telemetry opt-outs are absent, the identity may represent an account or an installation, and some active environments have no compatible desktop browser host. A low rate is evidence to investigate availability and discoverability before removing a feature. Track failed attempts separately from successful adoption; an unavailable feature can have demand without successful uses.

For reliability, include every action and outcome, then break down failures and p50/p95 `durationMs` by action and server version. Browser snapshot outcomes include saving a requested screenshot, and recording-stop outcomes include transferring its artifact. Internal status requests for tool icons do not emit additional usage events.

To add another feature, extend the fixed vocabulary in `apps/server/src/telemetry/FeatureUsage.ts` and observe its public operation once at the owning entry point. Measure fork-maintained behavior only: usage of an upstream feature does not inform whether to keep a fork difference. Include each applicable manual and agent entry point before interpreting the count as whole-feature adoption. Send structural metadata only; never pass operation arguments, results, names, URLs, paths, selectors, page content, or screenshots.
