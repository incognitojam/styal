# styal CLI releases

The public npm package is `@styal/cli`, with one executable named `styal`. Fork
Nightly and Fork Release build it from the same verified source and version as the
desktop clients. The package includes the web client, the service launcher, the
license, and resource monitors for Linux x64, macOS arm64, and Windows x64.

## Build and verify without publishing

```sh
vp run --filter ./apps/server build
node apps/server/scripts/cli.ts pack --output-directory .scratch/cli-release --verbose
docker run --rm \
  -v "$PWD/.scratch/cli-release:/artifacts:ro" \
  -v "$PWD/scripts/verify-cli-package.mjs:/verify.mjs:ro" \
  node:24-bookworm node /verify.mjs /artifacts
```

Ensure `.scratch/` is ignored before using it. The archive command resolves
workspace catalog versions and excludes pnpm-only overrides and development
metadata. It restores the source manifest and icons even if packing fails. The
container installs the archive with npm and exercises the executable, native
terminal, launcher compatibility, bundled web app, pairing, authenticated project
snapshot, and persistence across a server restart. It has no workspace dependencies
or host provider credentials mounted. CI repeats the check with npm 12 and explicit
local-manifest approvals for native install scripts. CI adds the native monitors built by the
three desktop jobs before packing.

## First publication

1. Own the `@styal` npm scope and have publish access to its public packages.
2. Run a fork nightly after this workflow lands. With `STYAL_CLI_PUBLISH_ENABLED`
   unset, CI verifies the archive and attaches `styal-cli-<version>.tgz` to the
   release without publishing to npm. Dry runs also never publish to npm.
3. Download that verified archive, log in with `npm login`, and publish it:

   ```sh
   npm publish ./styal-cli-<version>.tgz --access public --tag nightly
   ```

   Use the nightly version from the release. Do not mark a nightly as `latest`.

4. In the `@styal/cli` npm package settings, configure GitHub trusted publishers
   for owner `incognitojam`, repository `styal`, and each calling workflow:
   `fork-nightly.yml` and `fork-release.yml`. Allow direct `npm publish`. The
   reusable `fork-cli-build.yml` is not the calling workflow used by npm's trust
   check. No GitHub environment name is configured by these jobs.
5. Set the repository Actions variable `STYAL_CLI_PUBLISH_ENABLED` to `true`.
   Subsequent nightlies publish `nightly`; stable promotions publish `latest`.

The publish job uses a GitHub-hosted runner, Node 24, npm OIDC authentication, and
provenance. No persistent npm publish token is needed in repository secrets.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Release behavior

Once publishing is enabled, GitHub release publication waits for CLI publication
to succeed. An npm failure prevents promotion of the nightly pointer. npm versions
are immutable: if npm succeeds but a later release step fails, rerun only the
failed jobs to retain the verified archive and completed publish job. A full new
nightly run produces a new version.

The startup binary and archive version must match; the container check catches
metadata-only version overrides. Stable promotion must select a nightly that
contains the CLI packaging workflow. Previous desktop-only releases do not carry
an installable styal CLI version.

The final deployment check is installing the published exact version on a fresh
host and exercising service install, restart, remote update, and rollback. Local
launcher tests cover update commit and database rollback; the container verifies
foreground restart without requiring systemd. See the [background service
migration instructions](../user/background-service.md#migrating-an-existing-styal-installation)
for manually built hosts.
