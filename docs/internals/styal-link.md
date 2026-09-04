# styal Link

> For maintainers. Using styal? See [docs/user](../user/).

styal Link is the fork's deployment of upstream's T3 Connect. The mechanics — Clerk JWT
template, CLI OAuth flow, desktop redirect allowlist, passkeys, sign-up restrictions — are unchanged
and documented in [t3-connect.md](./t3-connect.md). This page is the styal-specific configuration:
the values our deployment uses and where each one has to be set. It describes the intended
configuration; when reality drifts from it, fix reality.

Product copy says **styal Link**. Internal identifiers stay upstream-named on purpose so the fork
stays mergeable: `t3 connect` CLI commands, `T3CODE_*` environment variables, `T3Connect*`
component names, the `t3-connect` Clerk profile page URL, `[t3-connect]` log tags, the `t3-relay`
JWT template, and the `t3-code-relay` audience.

## Fixed values

| Value                   | styal                                                                                                                                    | Decided in                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Hosted app origin       | `https://app.styal.build`                                                                                                                | `DEFAULT_HOSTED_APP_URL`, `packages/shared/src/connectAuth.ts` |
| CLI OAuth redirect URIs | `http://127.0.0.1:34338/callback`, `https://app.styal.build/connect/callback`                                                            | `connectCallbackUrl(DEFAULT_HOSTED_APP_URL)`                   |
| Desktop redirect URIs   | `styal-dev://app/` (dev), `styal://app/` (packaged)                                                                                      | `apps/desktop`, see t3-connect.md                              |
| macOS bundle ID         | `build.styal.app`                                                                                                                        | `DESKTOP_APP_ID`, `scripts/build-desktop-artifact.ts`          |
| Clerk application       | `styal` (`app_3IPih12l7JcyeHP2MlqFOESKdGN`)                                                                                              | Clerk Dashboard                                                |
| Relay                   | `https://relay.styal.build`, deployed by `deploy-relay.yml` on push to main                                                              | `infra/relay/README.md`                                        |
| Relay database          | Neon project `styal-relay` (`divine-frog-52827132`, `aws-eu-west-2`): prod adopts its `production` branch, dev stages fork Neon branches | `infra/relay/src/db.ts`                                        |
| Relay API zone          | `styal.build` (`RELAY_API_ZONE_NAME`), so the relay serves `relay.styal.build`                                                           | `production` environment variable                              |
| Managed tunnel zone     | `styal.link` (`RELAY_TUNNEL_ZONE_NAME`)                                                                                                  | `production` environment variable                              |

Tunnel endpoints (`prod-<digest>.styal.link`) terminate at servers that styal users control, so they
live on a registrable domain of their own, never under `styal.build`: the production Clerk instance
sets cookies on the product root domain, and a shared eTLD+1 would send those session cookies to any
tunnel host a browser touches. Keep it that way.

## Clerk

One Clerk application, `styal`, with a development and a production instance. Following upstream's
model, production backs everything CI builds — the hosted app, releases, macOS previews — plus
mobile; development backs local source builds and `styal-dev://` desktop dev builds only. Configure both instances identically except where noted. The
[`clerk` CLI](https://clerk.com/docs/cli) (`bunx clerk@latest`) is the fastest route; pass
`--app app_3IPih12l7JcyeHP2MlqFOESKdGN --instance dev|prod` explicitly and `--dry-run` every
mutation first.

1. **Email sign-up must be required.** The instances use email-code sign-in with no social
   providers, and Clerk renders an empty sign-up card unless `email_address` is also _required_
   (Dashboard: User & authentication → Email). Enabled-but-optional looks configured and is not.
2. **JWT template** named `t3-relay` with claims `{ "aud": "t3-code-relay" }`
   ([t3-connect.md § JWT Template](./t3-connect.md#jwt-template)). Check with
   `clerk api /jwt_templates`.
3. **CLI OAuth application** named `styal CLI`
   ([t3-connect.md § Headless CLI OAuth Application](./t3-connect.md#headless-cli-oauth-application)):
   public client (PKCE), scopes `openid profile email`, and **both** redirect URIs from the table
   above. The hosted callback must equal `connectCallbackUrl(DEFAULT_HOSTED_APP_URL)` exactly or
   `t3 connect --headless` and SSH authorization fail. Its client ID is `CLERK_CLI_OAUTH_CLIENT_ID`.
   Check with `clerk api /oauth_applications`.
4. **Native API** for desktop
   ([t3-connect.md § Desktop OAuth Redirect Allowlist](./t3-connect.md#desktop-oauth-redirect-allowlist)):
   enabled, with `styal-dev://app/` allowlisted on dev and `styal://app/` on prod, and the instance's
   `allowed_origins` set to the same scheme:

   ```sh
   clerk api /instance -X PATCH --instance dev -d '{"allowed_origins":["styal-dev://app"]}' --dry-run
   clerk api /instance -X PATCH --instance prod -d '{"allowed_origins":["styal://app"]}' --dry-run
   ```

5. **Passkeys** (production only,
   [t3-connect.md § Desktop Passkeys](./t3-connect.md#desktop-passkeys)): an iOS app entry in Clerk's
   Native API with our Apple Team ID and `build.styal.app`, and the AASA served from the production
   Frontend API. The RP domain derives from the production publishable key, so the
   `CLERK_PASSKEY_RP_DOMAINS` repository variable is only set when Clerk reports a different RP ID.

## GitHub Actions configuration

The four public identifiers are read as `vars.*`; they are not secrets. They are consumed by three
workflows at two scopes:

| Variable                    | `deploy-web.yml` (`production` env) | `release.yml` `relay_public_config` (`production` env) | `desktop-macos-preview.yml` (no environment) |
| --------------------------- | :---------------------------------: | :----------------------------------------------------: | :------------------------------------------: |
| `CLERK_PUBLISHABLE_KEY`     |                  ✓                  |                           ✓                            |                      ✓                       |
| `CLERK_JWT_TEMPLATE`        |                  ✓                  |                           ✓                            |                      ✓                       |
| `CLERK_CLI_OAUTH_CLIENT_ID` |                  ✓                  |                           ✓                            |                      ✓                       |
| `RELAY_URL`                 |                  ✓                  |                derived from relay state                |                      ✓                       |
| `STYAL_WEB_DOMAIN`          |   ✓ (also `VITE_HOSTED_APP_URL`)    |                                                        |                                              |

Every CI build uses the **production** instance — a single relay trusts a single Clerk instance,
so artifacts that talk to the production relay must all sign into production Clerk. Set the
production values (`pk_live_…`, `CLERK_JWT_TEMPLATE=t3-relay`, the prod OAuth client ID, and
`RELAY_URL` once the relay is deployed) as **repository variables**: jobs without an `environment:`
declaration — the macOS preview — see only that scope. `STYAL_WEB_DOMAIN` and the relay deployment
values live on the `production` environment, which can also shadow the Clerk variables when they
ever need to diverge. The preview job treats the three Clerk values as all-or-nothing (a partial
set fails the build) and builds Link-disabled with a notice while `RELAY_URL` is unset.

The development instance never appears in CI. It exists for local development: the repository-root
`.env` carries its identifiers, paired with a personal relay stage
(`vp run --filter t3code-relay deploy` with any stage name other than `prod`) so dev-Clerk tokens
are verified by a dev-Clerk relay.

Relay deployment (`deploy-relay.yml`) has its own set of variables and secrets — Cloudflare, Neon,
Axiom, optional APNs, `CLERK_SECRET_KEY`, `CLERK_JWT_AUDIENCE=t3-code-relay` — listed in
[infra/relay/README.md § Deployment CI](../../infra/relay/README.md#deployment-ci). The hosted web
app (`deploy-web.yml`) needs `CLOUDFLARE_ACCOUNT_ID`, `STYAL_WEB_DOMAIN`, and the
`CLOUDFLARE_API_TOKEN` secret; see [infra/web/README.md](../../infra/web/README.md).

## Deployment credentials

The four sensitive secrets — `CLOUDFLARE_API_TOKEN`, `CLERK_SECRET_KEY`, `NEON_API_KEY`,
`AXIOM_TOKEN` — live **only** in the `production` GitHub environment, which is restricted to
deployments from `main`. No PR or fork workflow can read them; repository-level secrets hold only
Apple-signing and release plumbing. Three of them have non-obvious shape requirements:

- `CLOUDFLARE_API_TOKEN` must be the superuser token minted by
  `./infra/relay/node_modules/.bin/alchemy cloudflare create-token --all-permissions`. The relay
  deploy mints scoped account API tokens for the Worker's tunnel and DNS bindings, and any
  credential allowed to mint account tokens is root-equivalent on the account regardless of its
  other permissions — hence environment-only storage rather than a narrower token.
- `NEON_API_KEY` must be an **organization** API key. Alchemy adopts the existing project by
  searching the projects list; a project-scoped key cannot list, so adoption misses and the
  deploy falls through to a (refused) create.
- `AXIOM_TOKEN` must be an **advanced API token**, accompanied by `AXIOM_ORG_ID`. Its exact
  organization- and dataset-level permissions are documented in
  [Relay Observability](../operations/relay-observability.md#deployment-token-permissions).

Fork workflows run on GitHub-hosted runners. Blacksmith `runs-on` labels survive in inherited
upstream workflows the fork does not run; Blacksmith is not installed for this account, so a job
that still carries one queues forever.

## Local source builds

Connect is disabled in a fresh clone. Put the development identifiers in the ignored
repository-root `.env` (or `.env.local`):

```dotenv
T3CODE_CLERK_PUBLISHABLE_KEY=<styal dev publishable key>
T3CODE_CLERK_JWT_TEMPLATE=t3-relay
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=<dev CLI OAuth client ID>
T3CODE_RELAY_URL=<relay URL, written automatically by a relay deploy>
```

Do not `cp .env.example .env`: the tracked example is upstream's and points a styal-branded build at
T3's production Clerk instance and relay. It is left untouched so upstream picks stay clean.

In styal-managed worktrees the `t3.json` setup script symlinks `$T3CODE_PROJECT_ROOT/.env` (and
`infra/relay/.env`) into each worktree, so populate the file once in the original checkout rather
than replacing the symlink.

## Verifying a build

- `t3 connect status` reports the expected exposure state instead of "missing public configuration".
- `t3 connect login --headless` completes through `https://app.styal.build/connect` and returns to
  the terminal.
- The desktop sign-in returns to the app via `styal-dev://app` (dev build) or `styal://app`
  (packaged build).
- The web sidebar shows **Sign in to styal Link** on `app.styal.build`.
