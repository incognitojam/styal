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

| Value                   | styal                                                                          | Decided in                                                     |
| ----------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Hosted app origin       | `https://app.styal.build`                                                      | `DEFAULT_HOSTED_APP_URL`, `packages/shared/src/connectAuth.ts` |
| CLI OAuth redirect URIs | `http://127.0.0.1:34338/callback`, `https://app.styal.build/connect/callback`  | `connectCallbackUrl(DEFAULT_HOSTED_APP_URL)`                   |
| Desktop redirect URIs   | `styal-dev://app/` (dev), `styal://app/` (packaged)                            | `apps/desktop`, see t3-connect.md                              |
| macOS bundle ID         | `build.styal.app`                                                              | `DESKTOP_APP_ID`, `scripts/build-desktop-artifact.ts`          |
| Clerk application       | `styal` (`app_3IPih12l7JcyeHP2MlqFOESKdGN`)                                    | Clerk Dashboard                                                |
| Relay                   | `infra/relay` deployed to our Cloudflare account by `deploy-relay.yml`         | `infra/relay/README.md`                                        |
| Relay API zone          | `styal.build` (`RELAY_API_ZONE_NAME`), so the relay serves `relay.styal.build` | `production` environment variable                              |
| Managed tunnel zone     | `styal.link` (`RELAY_TUNNEL_ZONE_NAME`)                                        | `production` environment variable                              |

Tunnel endpoints (`prod-<digest>.styal.link`) terminate at servers that styal users control, so they
live on a registrable domain of their own, never under `styal.build`: the production Clerk instance
sets cookies on the product root domain, and a shared eTLD+1 would send those session cookies to any
tunnel host a browser touches. Keep it that way.

## Clerk

One Clerk application, `styal`, with a development and a production instance. Development backs
source builds, macOS previews, and `styal-dev://` desktop builds; production backs `app.styal.build`,
release builds, and mobile. Configure both instances identically except where noted. The
[`clerk` CLI](https://clerk.com/docs/cli) (`bunx clerk@latest`) is the fastest route; pass
`--app app_3IPih12l7JcyeHP2MlqFOESKdGN --instance dev|prod` explicitly and `--dry-run` every
mutation first.

1. **JWT template** named `t3-relay` with claims `{ "aud": "t3-code-relay" }`
   ([t3-connect.md § JWT Template](./t3-connect.md#jwt-template)). Check with
   `clerk api /jwt_templates`.
2. **CLI OAuth application** named `styal CLI`
   ([t3-connect.md § Headless CLI OAuth Application](./t3-connect.md#headless-cli-oauth-application)):
   public client (PKCE), scopes `openid profile email`, and **both** redirect URIs from the table
   above. The hosted callback must equal `connectCallbackUrl(DEFAULT_HOSTED_APP_URL)` exactly or
   `t3 connect --headless` and SSH authorization fail. Its client ID is `CLERK_CLI_OAUTH_CLIENT_ID`.
   Check with `clerk api /oauth_applications`.
3. **Native API** for desktop
   ([t3-connect.md § Desktop OAuth Redirect Allowlist](./t3-connect.md#desktop-oauth-redirect-allowlist)):
   enabled, with `styal-dev://app/` allowlisted on dev and `styal://app/` on prod, and the instance's
   `allowed_origins` set to the same scheme:

   ```sh
   clerk api /instance -X PATCH --instance dev -d '{"allowed_origins":["styal-dev://app"]}' --dry-run
   clerk api /instance -X PATCH --instance prod -d '{"allowed_origins":["styal://app"]}' --dry-run
   ```

4. **Passkeys** (production only,
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

Set them as follows:

- **Repository variables** carry the development instance: `CLERK_PUBLISHABLE_KEY` (`pk_test_…`),
  `CLERK_JWT_TEMPLATE=t3-relay`, `CLERK_CLI_OAUTH_CLIENT_ID` (dev OAuth app), `RELAY_URL`. Jobs
  without an `environment:` declaration — the macOS preview — see only these. The preview job treats
  the three Clerk values as all-or-nothing (a partial set fails the build) and builds Connect-disabled
  with a notice while `RELAY_URL` is unset, since the relay URL only exists once the relay is
  deployed.
- **`production` environment variables** carry the production instance under the same names:
  `CLERK_PUBLISHABLE_KEY` (`pk_live_…`), `CLERK_CLI_OAUTH_CLIENT_ID` (prod OAuth app), plus
  `STYAL_WEB_DOMAIN=app.styal.build`. Environment variables shadow repository variables of the same
  name, so `deploy-web.yml` and release builds pick up production automatically.

Until the production instance exists, leave the `production` environment without Clerk variables so
those jobs fall through to the development values.

Relay deployment (`deploy-relay.yml`) has its own set of variables and secrets — Cloudflare,
PlanetScale, Axiom, APNs, `CLERK_SECRET_KEY`, `CLERK_JWT_AUDIENCE=t3-code-relay` — listed in
[infra/relay/README.md § Deployment CI](../../infra/relay/README.md#deployment-ci). The hosted web
app (`deploy-web.yml`) needs `CLOUDFLARE_ACCOUNT_ID`, `STYAL_WEB_DOMAIN`, and the
`CLOUDFLARE_API_TOKEN` secret; see [infra/web/README.md](../../infra/web/README.md).

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
