# Relay observability

> For maintainers. Using T3 Code? See [docs/user](../user/).

## Cleanup and idle database compute

The relay prunes expired DPoP proofs and old terminal activity rows hourly, at minute zero UTC.
Proof age is checked during verification, and activity display expiry is checked while building
aggregates. Physical cleanup can therefore lag those expiry windows without extending them.
Hourly maintenance leaves room for Neon's five-minute idle timeout; regular relay traffic or
connection-pool checks may still prevent suspension.

### Verification and rollout

Before merging, run the focused DPoP and agent activity tests. They verify replay rejection, proof
expiry, and display expiry for rows retained between maintenance runs. These checks establish
application behavior, not production compute savings.

A push to `main` triggers `.github/workflows/deploy-relay.yml`; a pull request does not deploy a
preview relay. After the production deployment succeeds:

1. Exercise normal relay discovery/connection and agent activity delivery.
2. Verify `relay.cron.prune_expired_state` runs hourly in Axiom.
3. Allow an otherwise idle interval after the five-minute suspend timeout, away from the hourly
   cleanup. Check Neon endpoint state and start/suspend operations through its control-plane API
   or console, rather than repeatedly querying Postgres.
4. Compare compute consumption over comparable before/after periods using CU-hours per elapsed
   hour, ideally over a day with similar traffic. Record whether suspension occurs. Query execution
   time is not billed CU time, and query statistics reset when Neon suspends.

Avoid polling `/health` during the idle measurement: it queries Postgres and can wake the database
or postpone suspension. If compute stays active, correlate request traffic and connection checks
before changing more settings. `SELECT 1` statistics alone cannot distinguish health probes from
connection checks.

## Tracing resources

The relay Alchemy stack owns a shared Axiom trace setup:

- `t3-code-relay-traces-prod`, the OpenTelemetry trace dataset shared by the Worker, mobile app, and
  first-party relay clients
- `t3-code-relay-otel-ingest-prod`, the dataset-scoped Worker ingest token
- `t3-code-mobile-otel-ingest-prod`, the dataset-scoped mobile ingest token
- `t3-code-relay-client-otel-ingest-prod`, the dataset-scoped first-party relay-client ingest token
- `t3-code-relay-recent-spans-prod`, a view of recent request and endpoint spans

Alchemy stages append their sanitized stage name to isolate resources, for example
`t3-code-relay-traces-dev-julius` for a personal stage.

Deploy from `infra/relay` with the normal Alchemy workflow:

```sh
vp run deploy
```

Alchemy resolves account-level Axiom deployment credentials through its provider. At runtime, the
Worker receives only its scoped ingest token. Mobile and relay clients use their own separately
provisioned scoped ingest tokens.

## Deployment token permissions

Production `AXIOM_TOKEN` is an advanced API token, not a basic ingest token. Store it in the
`production` GitHub environment and provide the organization identifier separately as
`AXIOM_ORG_ID`.

Grant the deployment token these organization-level permissions:

- API tokens: Create, Read, Update, and Delete
- Datasets: Create, Read, Update, and Delete
- Views: Create, Read, Update, and Delete

Grant it these permissions on the existing `t3-code-relay-traces-prod` dataset:

- Ingest: Create
- Query: Read

These permissions let Alchemy adopt and update the dataset and view, mint the three producer ingest
tokens, and validate the managed query. They are deployment permissions only; the Worker, mobile
app, and relay clients continue to receive separate write-only tokens scoped to the trace dataset.

[Axiom API token permissions are immutable](https://axiom.co/docs/reference/tokens). To change them,
create a replacement advanced token with the complete permission set and replace the `AXIOM_TOKEN`
environment secret. Rotating that deployment token does not require reinstalling or relinking any
client because it is never shipped in an application.

The Worker emits Effect's built-in HTTP server spans plus endpoint and database child spans.
Effect's OpenTelemetry exporter stores semantic HTTP attributes below the `attributes.` prefix.
For example:

```apl
['t3-code-relay-traces-prod']
| where name startswith 'http.server'
| extend endpoint = column_ifexists('attributes.http.route', ''),
    customAttributes = column_ifexists('attributes.custom', dynamic({}))
| project _time, name, trace_id, duration,
    ['attributes.http.request.method'],
    ['attributes.url.path'],
    ['attributes.http.response.status_code'],
    endpoint,
    relayOperation = customAttributes['relay']['operation']
| order by _time desc
| limit 200
```

The provisioned view also reads the endpoint from `attributes.http.route`. Relay-specific span
annotations are stored under `attributes.custom`; `relay.operation` is one of the emitted custom
attributes.

Agents should prefer the provisioned view or APL queries for completed incidents instead of
tailing the Cloudflare Worker. The stack does not provision a separate query token. Responders who
need scripted query access use the authorized deployment `AXIOM_TOKEN` together with
`AXIOM_ORG_ID`; scoped ingest tokens remain write-only credentials for their producers.

DPoP proof failures include the stable `relay.dpop.failure_code` span attribute. A `time_window`
failure means that a signed proof was too old or too far in the future for the relay's allowed
window. It can point to a date or time problem on either device, but it can also result from a
delayed request. The client uses this category, and the absence of a category from an older relay,
to decide whether clock skew is confirmed or only one possible cause.
