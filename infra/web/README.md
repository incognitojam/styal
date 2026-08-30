# styal web hosting

Deploys the styal web app to Cloudflare Workers, alongside the relay stack in
`infra/relay` rather than on a second vendor.

## Why this is not release-gated

Upstream deploys its hosted web app to Vercel only after a stable GitHub
Release succeeds. styal has no stable release yet, so copying that trigger
would mean the hosted app never deploys. This stack is a rolling deployment of
`main` instead, matching how `deploy-relay.yml` works. Desktop builds stay
versioned and promoted; the web app tracks the patch stack.

`apps/web/vercel.ts` is upstream's and is left alone. Its cookie-based channel
router exists so upstream's hosted users can opt a session into nightly; styal
serves a single origin and does not need it.

## Prerequisites

- The Cloudflare zone for the target hostname must already exist in the
  account. Alchemy infers the zone from `STYAL_WEB_DOMAIN` and does not create
  it.
- A Cloudflare API token with Workers and DNS edit permissions.

## Configuration

Repository variables:

- `CLOUDFLARE_ACCOUNT_ID` — shared with the relay deployment.
- `STYAL_WEB_DOMAIN` — the hostname to serve, for example `app.styal.build`.
- `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, `CLERK_CLI_OAUTH_CLIENT_ID`,
  `RELAY_URL` — public client configuration baked into the bundle.

The deployment workflow exposes `RELAY_URL` to Vite as `VITE_T3CODE_RELAY_URL` and derives
`VITE_HOSTED_APP_URL` from `STYAL_WEB_DOMAIN`. The hosted origin must remain available even when
the Clerk or relay values are absent so the static app can show its local-connection onboarding
state without probing for a primary server.

Repository secret:

- `CLOUDFLARE_API_TOKEN`

Never set `VITE_HTTP_URL` or `VITE_WS_URL` here. The hosted app must stay
origin-relative, or every remote browser breaks.

## Local deploy

```sh
vp run --filter styal-web-infra deploy
```

Requires the same variables in the environment.
