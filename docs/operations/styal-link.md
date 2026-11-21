# styal Link

> For maintainers. Using styal? See [docs/user](../user/).

styal Link is the fork's deployment of T3 Connect. The relay owns email sign-in and sessions.
[Sign-in setup and Clerk retirement](./connect-setup.md) owns the rollout and deletion checklist;
this page records the deployment's public configuration.

## Fixed values

- Hosted app: `https://app.styal.build`.
- Production relay: `https://relay.styal.build`; development: `https://relay-dev.styal.build`.
- API zone: `styal.build`; managed tunnel zone: `styal.link`. Keep user-controlled tunnel hosts
  on their own registrable domain, away from product cookies.
- Desktop bundle ids: `build.styal.app` and `build.styal.app.preview`.

## GitHub Actions configuration

Release and preview builds use the repository variable `RELAY_URL`, passed as `T3CODE_RELAY_URL`.
The hosted web deployment reads its relay URL from the `production` environment. Keep both scopes
consistent; release jobs without an environment cannot read environment variables.
`STYAL_WEB_DOMAIN` lives on `production`. The relay README lists deployment variables and secrets.
The relay workflow deploys `prod` on main changes affecting it, then `dev`; client release channels
share the production relay. A preview configured for production uses real production email sign-in.

## Deployment credentials

The sensitive secrets — `CLOUDFLARE_API_TOKEN` and `NEON_API_KEY` — live **only** in the `production` GitHub environment, which is
restricted to deployments from `main`. No PR or fork workflow can read them; repository-level
secrets hold only Apple-signing and release plumbing. Two of them have non-obvious shape
requirements:

- `CLOUDFLARE_API_TOKEN` must be the superuser token minted by
  `./infra/relay/node_modules/.bin/alchemy provider cloudflare token --all-permissions`. The relay
  deploy mints scoped account API tokens for the Worker's tunnel and DNS bindings, and any
  credential allowed to mint account tokens is root-equivalent on the account regardless of its
  other permissions — hence environment-only storage rather than a narrower token.
- `NEON_API_KEY` must be an **organization** API key. Alchemy adopts the existing project by
  searching the projects list; a project-scoped key cannot list, so adoption misses and the
  deploy falls through to a (refused) create.

PR web previews (`web-preview.yml`) cannot use that token: they deploy from PR branches, and any
Alchemy stage shares the account-wide state store with production. They deploy with wrangler and a
separate Workers-only token that only the upload job can read; setup is in
[PR previews](./development.md#pr-previews).

Fork workflows run on GitHub-hosted runners. Blacksmith `runs-on` labels survive in inherited
upstream workflows the fork does not run; Blacksmith is not installed for this account, so a job
that still carries one queues forever.

## Local source builds

Copy `.env.development.example` to `.env.local` to build against the development relay.
Only `T3CODE_RELAY_URL` is needed for email sign-in. Existing worktree setup may symlink env files;
edit their original checkout rather than replacing a symlink. See the development runbook for
isolated state. Production credentials never belong in client build files.

## Verifying a build

Sign in with an emailed code, confirm the same machines, relaunch and confirm the session persists,
then sign out and verify reconnect requires sign-in. CLI users run `styal link login` and
`styal link status`. Verify against development with the agent test account and configured fixed
code before using a released build in the production checklist.
