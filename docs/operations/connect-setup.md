# styal Link sign-in

The relay owns account sign-in and sessions. Web, desktop, mobile and the CLI sign in with an
eight-digit emailed code. The [relay README](../../infra/relay/README.md#deployment) owns provisioning;
[styal Link](./styal-link.md) records this deployment's configuration.

## Public application configuration

Set `T3CODE_RELAY_URL` to the relay's HTTPS origin before building. Process variables take
precedence over `.env.local`, then `.env`. Bundled servers accept runtime overrides. No Clerk
application key, JWT template, OAuth app or native redirect is needed after client retirement.

## Email sign-in

A sender needs a domain onboarded to Cloudflare Email Sending and the Workers Paid plan.
`RELAY_EMAIL_FROM_ADDRESS` enables delivery; `RELAY_EMAIL_FROM_NAME` defaults to `styal`.
Without a sender the endpoints return `email_sign_in_unavailable`. Preserve the relay signing
keys: changing them is separate work and can invalidate credentials or codes.

On non-production stages, `RELAY_EMAIL_DELIVERY=log` writes codes to Worker logs instead of
sending email. `RELAY_TEST_SIGN_IN_CODE` accepts a fixed eight-digit code for `agent+…@styal.build`
addresses. The shared development deployment reads `RELAY_DEV_EMAIL_DELIVERY` and
`RELAY_DEV_TEST_SIGN_IN_CODE`. Both settings are refused on `prod`. Alchemy's `--env-file`
overrides shell values; do not use an old env file to reintroduce removed settings.

## Retiring Clerk compatibility

The production import and email cutover have already happened. This removal does not change
stored users, ids, email mappings, sessions or links. Never edit or rename a deployed migration.
For a new deployment needing a historical import, use the pre-removal revision's tooling before
this version; do not recreate accounts under new ids.

The maintainer owns every production check and setting below. Agents may prepare code, builds and
local tests. No telemetry is required for three accounts: ask each owner to inventory every browser
profile, desktop install, store mobile build, nightly, spare phone and background server/CLI home.

1. Release the client removal separately while the relay still supports older clients. An already
   converted device keeps its relay session. An unconverted updated GUI shows email sign-in;
   signing in with the imported address restores the same machines. Local work stays available.
   A not-yet-updated mobile binary can keep using Clerk only until relay retirement.
2. Have all three owners open each device and restart each server, confirm their account and
   machines, and confirm a relay session in **styal Link account → Signed-in devices**. On every
   server use `styal link login` if needed, then `styal link status` and connect from a signed-in
   client. A server and CLI sharing one home may share one session. Do not count a session row as
   proof that every device converted; missing devices, expired sessions and abandoned installs
   must be explicitly accounted for by their owner.
3. Check only aggregate counts and the maintainer's own account in the relay database. Do not
   export credentials, code hashes, DPoP keys, friends' labels or account identifiers. These are
   read-only SQL examples for the maintainer's own database console:

   ```sql
   SELECT count(*) AS accounts, count(email) AS mapped_emails FROM relay_users;
   SELECT client_id, count(*) AS live_sessions
   FROM relay_auth_sessions WHERE expires_at::timestamptz > now() GROUP BY client_id;
   ```

   The first query should still describe the three imported accounts with their verified email
   mappings. Counts alone cannot prove migration. For his own account only, bind `$1` to his own
   known account id in a parameterized query:

   ```sql
   SELECT client_id, label, last_used_at, expires_at
   FROM relay_auth_sessions WHERE user_id = $1 ORDER BY created_at;
   SELECT count(*) AS links FROM relay_environment_links WHERE user_id = $1;
   ```

   Compare his links and sessions before/after; ask his friends to confirm their own equivalent
   results privately. Stop for an unexpected account count, missing mapping, missing machines or
   any owner who cannot account for a device. Legacy mobile registration rows with null session
   ids are historical data, not evidence of a currently active Clerk client; keep them.

4. Only after every device/server is accounted for, merge the relay retirement. **Merging relay
   changes to main automatically deploys production, then development.** Review that plan before
   approval: expect Worker code and removal of Clerk bindings, no database, queue, DNS or tunnel
   destruction. Old Clerk bearer requests now fail authentication; `/v1/client/dpop-token` and
   `/v1/auth/clerk-exchange` return 404, OAuth discovery is retired, and signed sessionless
   legacy tokens are refused.
   Existing environment credentials and tunnels remain, but old clients cannot establish new
   authenticated control-plane connections. Servers with only a Clerk credential must use the email-only client build or the
   transition build's interactive email recovery; silent exchange no longer works.
5. Smoke-test email login, reload/relaunch, sign-out and reconnect on released GUI and CLI builds;
   confirm existing relay sessions and the same machines still work. Recheck aggregate counts and
   his own links. Before deleting Clerk, an operator can redeploy the previous relay revision with
   its original bindings to restore compatibility; it does not undo email sessions or new-client
   sign-outs. Preserve the rollback configuration privately; an empty `CLERK_SECRET_KEY=` does not
   remove an Alchemy stage binding.
6. After a chosen rollback window and all releases, delete unused GitHub Actions Clerk settings
   using Settings → Secrets and variables → Actions for repository scope and Settings →
   Environments → production for environment scope. The environment currently holds secrets
   `CLERK_SECRET_KEY` and `CLERK_DEV_SECRET_KEY`. Repository variables are
   `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE` and `CLERK_CLI_OAUTH_CLIENT_ID`; the environment
   has those three plus `CLERK_JWT_AUDIENCE`. Remove `CLERK_PASSKEY_RP_DOMAINS` if set later.
   Remove `T3CODE_CLERK_*`, `VITE_CLERK_*` and `EXPO_PUBLIC_CLERK_*` from local build/EAS files
   after no supported build reads them. Confirm the Worker has no Clerk bindings. Keep email,
   database, Cloudflare, mobile push and browser-passkey signing configuration.
7. Delete the Clerk CLI OAuth app, JWT template, native application/redirect/passkey configuration,
   then the production and development instances/application in the [Clerk dashboard](https://clerk.com/docs/guides/dashboard/overview) when no other
   service uses them. **Clerk deletion is the irreversible point:** old credentials, sessions and
   identities cannot be recovered by reverting code. It must be last. Revoke any remaining Clerk
   API keys. Rotate the two separately identified cutover secrets as their own reviewed operation;
   never delete or rotate relay signing keys as part of this cleanup.

Choose the rollback window and whether abandoned devices must be recovered or deliberately retired
before approving the relay PR. Clerk bans, sign-up restrictions and email edits no longer control
relay accounts after retirement; use the relay's session/account controls. T3 Chat keeps its existing
external `clerkUserId` JSON field for protocol compatibility; it receives the stable relay id and
reads email from the relay account, never Clerk.
