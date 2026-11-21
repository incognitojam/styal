# T3 Connect setup

Deployment and client configuration for T3 Connect. The [architecture note](../internals/t3-connect.md)
explains the trust boundaries; the [relay README](../../infra/relay/README.md#deployment) owns relay
provisioning instructions. [styal Link](./styal-link.md) lists the values styal's
deployment uses.

## Public application configuration

T3 Connect is disabled in a fresh clone. To build against the production deployment, copy the
repository-root example:

```sh
cp .env.example .env
```

For another deployment, set the relay origin in the repository-root `.env` or `.env.local`:

```dotenv
T3CODE_RELAY_URL=https://relay.example.com
```

Web, desktop, and mobile need only this public value. Process variables take precedence over
`.env.local`, then `.env`. Client and bundled-server builds embed it; bundled servers also accept
runtime overrides. The build loader supplies the web alias.

The CLI still needs `T3CODE_CLERK_PUBLISHABLE_KEY` and `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` only to
adopt a credential from before relay sign-in. Keep these public build values until the separate
relay compatibility retirement. New GUI builds ignore Clerk credentials and ask for an emailed
code when no relay session is stored. Signing in with the imported email restores the same machines.

Copy `infra/relay/.env.example` to `infra/relay/.env` for relay deployment settings.
The relay README owns provisioning; deployment's `PublishClientConfig` writes the relay URL to `.env`.

## CLI OAuth application

Current CLIs sign in with an emailed code and use this application only to move a Clerk sign-in
they already hold to the relay. CLIs from before email sign-in still sign in through it, so keep it
configured until Clerk is removed.

In Clerk's OAuth applications settings:

1. Create a public OAuth application for the T3 CLI, using authorization-code exchange with PKCE.
2. Allow the redirect URI `http://127.0.0.1:34338/callback`.
3. Enable the `openid`, `profile`, `email`, and `offline_access` scopes.
4. Enable **Device authorization grant** on the application. Older CLIs use it for headless and
   SSH authorization, and Clerk only advertises the device endpoint once it is on. The feature is in beta and
   Clerk enables it per account on request.
5. Set `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` to the generated public client ID in local and release
   build environments.

## Legacy relay tokens

Keep `CLERK_JWT_AUDIENCE=t3-code-relay` and the existing Clerk JWT template for older clients
until the relay compatibility retirement. Current GUI builds neither load the SDK nor request
Clerk tokens. Desktop builds no longer need account-provider redirects, RP domains or associated
domains. Their provisioning profile is still used for passkeys in the in-app browser.

## Restricting sign-ups

Use Clerk's allowlist for permitted email addresses or domains, or Restricted mode for invitation-only
sign-up. An enabled empty allowlist blocks all new sign-ups.

Sign-up restrictions do not revoke an existing account's access. Ban the account in Clerk when
its active Clerk sessions and future sign-ins must be disabled, including sign-in by email and moving
a Clerk sign-in to the relay. A ban does not end relay sessions already issued; delete the user's
`relay_auth_sessions` rows as well.

## Email sign-in

The relay signs users in with an eight-digit code sent by email, without Clerk. It stays off until a
sender is configured; until then the sign-in endpoints answer `email_sign_in_unavailable`.

Requirements:

- A sending domain onboarded to Cloudflare Email Sending in the relay's Cloudflare account.
- The Workers Paid plan, which Email Sending needs for arbitrary recipients.
- `RELAY_EMAIL_FROM_ADDRESS` set to an address on that domain (see the
  [relay README](../../infra/relay/README.md)).

Enable it on a stage that already has Clerk users in this order, so existing users keep their
account id and data when they sign in by email:

1. Deploy the relay with `RELAY_EMAIL_FROM_ADDRESS` unset.
2. Run a dry run, then the import, against the stage's direct (non-pooled) Neon connection string
   from the Neon console. For the `dev` stage use its Neon branch and the development instance's
   secret key (`CLERK_DEV_SECRET_KEY`):

   ```sh
   CLERK_SECRET_KEY=sk_... RELAY_DATABASE_URL=postgres://... node infra/relay/scripts/import-clerk-users.ts
   CLERK_SECRET_KEY=sk_... RELAY_DATABASE_URL=postgres://... node infra/relay/scripts/import-clerk-users.ts --apply
   ```

3. Restrict Clerk sign-ups, then run the import again.
4. Set `RELAY_EMAIL_FROM_ADDRESS` and redeploy.

Users without a verified Clerk email are not imported. Older transition builds that still hold a Clerk session move
over through `/v1/auth/clerk-exchange`, which keeps the Clerk user id either way.

During the transition, email sign-in checks Clerk's current verified addresses before using an
imported account and looks up unmapped addresses in Clerk before creating an account. Clerk exchange
refreshes the account's email each time. A stale email is cleared if no verified replacement is
available or its replacement belongs to another account. A Clerk outage fails with
`upstream_unavailable`; after email-code redemption, request a new code before retrying.

Ship the relay before the clients that use it. The transition build signs out of Clerk once
it has a relay session, so it cannot fall back to an older relay, and a signed-out user can only
sign in once email delivery works. Deploy and verify the relay, finish the steps above on `prod`,
and confirm a real sign-in email arrives before releasing web, desktop, mobile, or the CLI.

On non-production stages, `RELAY_EMAIL_DELIVERY=log` turns email sign-in on and writes codes to the
worker log instead of sending them (read them with `wrangler tail` or the Worker's Live logs in the
Cloudflare dashboard; `alchemy logs` does not show them), and `RELAY_TEST_SIGN_IN_CODE` sets a fixed
code accepted for
`agent+…@styal.build` addresses. The test code needs a sender or log delivery; on its own, sign-in
stays off. The deploy refuses both on `prod`. For the shared `dev` stage these come from the
`RELAY_DEV_EMAIL_DELIVERY` and `RELAY_DEV_TEST_SIGN_IN_CODE` variables.
