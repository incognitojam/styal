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

## Standalone archives

Fork Nightly and Fork Release additionally build `styal-<version>-<platform>-<arch>`
archives and attach `SHA256SUMS`. The native matrix covers macOS arm64, Linux
x64/arm64, and Windows x64/arm64. Intel macOS is unsupported. Each archive contains
the executable, web client, license, native dependencies, and resource monitor.
Node and native build tools are needed on the build runner, not the destination.
Provider CLIs may still need their own Node installation.

The archive job runs independently of desktop packaging. It shares the web build
across targets and builds and verifies each executable on its own architecture.
The npm package and existing service installation path remain available during
this first distribution phase. Building an archive does not migrate a service.

To verify a local Linux x64 archive (with `.scratch/` ignored):

```sh
vp run --filter ./apps/server build
VP_NODE_VERSION=26.8.2 node apps/server/scripts/cli.ts build-exe --verbose
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
mkdir -p .scratch/cli-resource-monitor/linux-x64
cp native/resource-monitor/target/release/styal-resource-monitor .scratch/cli-resource-monitor/linux-x64/
VP_NODE_VERSION=26.8.2 node scripts/build-cli-archive.ts --platform linux --arch x64 --version <version> --resource-monitor-dir .scratch/cli-resource-monitor --output-dir .scratch/cli-archives
VP_NODE_VERSION=26.8.2 node scripts/smoke-cli-archive.mjs .scratch/cli-archives/styal-<version>-linux-x64.tar.gz <version>
```

Use the version compiled into the executable. Release workflows align package
versions before building. Keep the archive builder and verifier on the same Node
version as the executable so native addon verification uses the matching ABI.
The smoke check extracts into synthetic scratch state, runs without Node on PATH,
opens a bundled terminal, pairs a client, reads its authenticated project snapshot,
and verifies persistence after restart. Logs remain in the reported scratch path.

macOS release archives use the fork's Developer ID certificate and notarization
credentials; local builds use ad hoc signing. Windows archives follow the fork's
unsigned Windows release policy unless Azure Trusted Signing is explicitly
configured. Checksums are generated only after every target's verification passes,
and cover the final archive bytes after signing.
