# Relay observability

> For maintainers. Using T3 Code? See [docs/user](../user/).

The relay prunes expired DPoP proofs and old terminal activity rows hourly, at minute zero UTC,
so maintenance leaves room for Neon to suspend when idle. Proof and activity display expiry are
enforced independently of cleanup. After deployment, verify that Neon suspends and compute usage
falls; other relay traffic may still keep it awake.

Relay logs are in the Worker's Workers Logs in the Cloudflare dashboard. The Worker does not export
its spans anywhere: the span names and attributes below exist in the code and reach a receiver only
if a deployment adds a tracer to the Worker.

DPoP proof failures include the stable `relay.dpop.failure_code` span attribute. A `time_window`
failure means that a signed proof was too old or too far in the future for the relay's allowed
window. It can point to a date or time problem on either device, but it can also result from a
delayed request. The client uses this category, and the absence of a category from an older relay,
to decide whether clock skew is confirmed or only one possible cause.

## Webhooks

A public webhook request is one `relay.hooks.forward` span. Its `relay.hook.outcome` says what
happened: `forwarded`, `held`, `rate_limited`, `inbox_full`, `not_found`, `payload_too_large`,
`environment_unavailable`, or `environment_timeout`. `relay.hook.endpoint_key` identifies the
managed endpoint, and with it the environment. On a forward, `relay.hook.upstream_status` or
`relay.hook.upstream_error` records the environment's answer, and
`relay.hook.upstream_outcome` what it did with the request (`accepted`, `duplicate`,
`prompt_too_long`, `queue_full`, `rejected_signature`, `expired`, `disabled`, ...), from its
`x-t3-hook-outcome` response header. A held request's delivery records the same on its
`relay.inbox.deliver` span. The relay sends its own `traceparent` with each forward and drops any a
sender supplied, and signs each forward (`x-t3-relay-delivery`) so the environment trusts the
relay's delivery id, receive time and trace context only from the relay. `relay.hook.rate_limit` says which
budget ran out: `endpoint` or `hook`. `relay.hook.rate_limiter_failed_open` is set when the
Cloudflare rate limiter was unavailable and the request went through unlimited.

Held requests are handled in the endpoint's `HookInboxObject`, and each call into it is its own
trace, not a child of the forward span: `relay.inbox.hold`, `relay.inbox.wake`, and
`relay.inbox.deliver` for each alarm run. Each carries `relay.hook.endpoint_key`, so they join to
forwards. The details are on the child spans: `HookInboxStore.hold` carries
`relay.inbox.refused` when the inbox refused a request (`max_per_hook`, `max_requests`,
`max_bytes`, or `already_held`). `HookInboxStore.deliverDue` carries `relay.inbox.run_result`
(`drained`, `more_pending`, `busy`, or `unreachable`), how many requests it sent and delivered,
the consecutive failures behind the retry delay, the longest time a delivered request waited, and
the backlog left. A run that errored outright has `relay.inbox.run_result = failed` on the root
`relay.inbox.deliver` span instead.

## Axiom resource removal

styal removed Axiom from the relay, but Alchemy state for `prod`, `dev`, personal stages and PR
previews still holds the datasets, ingest tokens, view, monitors and dashboards earlier deploys
created. The next successful deploy of each stage destroys them, along with the mobile source map R2
bucket and its upload token.

The stack keeps `Axiom.providers()` and the deploy workflows keep `AXIOM_TOKEN` and `AXIOM_ORG_ID`
only until those resources are destroyed, because Alchemy cannot delete a resource without its
provider. While the provider stays, every stage needs Axiom credentials to plan, including a new one
with nothing to destroy, and `AXIOM_TOKEN` must stay an advanced API token that can read and delete
API tokens, datasets and views, in the `production` GitHub environment.

R2 refuses to delete a bucket with objects in it. If a production deploy fails with `BucketNotEmpty`
on `t3-code-mobile-sourcemaps-prod`, empty that bucket and run the deploy again. Other stages empty
theirs on the way out.

Earlier deploys also wrote `T3CODE_MOBILE_OTLP_TRACES_*` and `T3CODE_RELAY_CLIENT_OTLP_TRACES_*` into
the repository-root `.env`. Delete those lines from a checkout that has them: their tokens stop working
once the stage's resources are destroyed, and source builds would keep trying to use them.
