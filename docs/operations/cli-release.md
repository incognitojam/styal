# styal CLI releases

Fork Nightly and Fork Release build five standalone archives and attach them, with
`SHA256SUMS`, to the GitHub Release. npm carries only `@styal/cli`, a dependency-free
launcher (`scripts/npm-launcher/styal.mjs`). On first run it downloads its exact
version's archive from the GitHub Release, verifies it against `SHA256SUMS`, and unpacks
it into `<styal home>/runtime/styal-executable/versions/<version>`, the layout the install
scripts and `styal update` use. The installed command is `styal`. The npm bridge at
`dist/bin.mjs` supports preflight from older service updaters.

The executables used to ship as `@styal/cli-<platform>` optional dependencies. npm
accepted those large uploads and then kept them unreadable for longer than the release
could wait, which blocked every release. Those packages keep their old versions and get
no new ones.

## Build and verify the npm launcher without publishing

After building the archives described below:

```sh
node scripts/build-npm-launcher.ts --version <version> --output-dir .scratch/cli-npm
docker run --rm \
  -v "$PWD/.scratch/cli-npm:/artifacts:ro" \
  -v "$PWD/.scratch/cli-archives:/archives:ro" \
  -v "$PWD/scripts/verify-cli-package.mjs:/verify.mjs:ro" \
  node:26-bookworm node /verify.mjs /artifacts /archives /verification
```

The archives directory must hold `SHA256SUMS` and the Linux x64 archive. The verifier
serves it over local HTTP in place of the GitHub Release, installs the launcher with
npm, and lets the first run download and verify the archive. It then stops that server,
so every later check runs from the cached download. It checks the old protocol 3
preflight refusal, including through `dist/bin.mjs`, exercises a native terminal, pairs
with the bundled web server, reads a synthetic project, and checks persistence after
restart. It mounts no host state or provider credentials.

## Publication setup

Configure trusted publishing for `@styal/cli` with owner `incognitojam`, repository
`styal`, and calling workflows `fork-nightly.yml` and `fork-release.yml`. The calling
workflow, not reusable `fork-cli-build.yml`, identifies the OIDC trust relationship. No
GitHub environment is configured. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

With `STYAL_CLI_PUBLISH_ENABLED` unset, CI builds and verifies the launcher and attaches
its tarball to the release without publishing. Dry runs never publish. Nightlies use
`nightly`; stable releases use `latest`.

The GitHub Release publishes first and does not wait for npm. The npm job starts only
after the release succeeded, confirms the release's `SHA256SUMS` is downloadable, and then
publishes the launcher, so a dist-tag never points at a version whose archives cannot be
downloaded. `styal update` and the mobile app's update check read the `@styal/cli`
dist-tags and also confirm the release's `SHA256SUMS` exists before offering a version.
An npm failure does not remove or roll back the GitHub Release; Fork Nightly reports it
to Discord. Re-run the failed npm job to retry; a release whose npm job is never retried
stays installable from the GitHub Release, but npm channels and update checks keep
offering the previous version.

npm publication is immutable. Retries accept an existing version only when its registry
integrity matches the release tarball and its channel tag points to the release version.
An existing version with an older or missing channel tag fails publication; an operator
must repair the tag using separate npm authentication before retrying. Before publishing
or accepting the package, the workflow checks the launcher's channel tag and rejects a
target older than the current tag. Registry errors fail closed; a missing package or
channel tag allows first publication of a version that does not yet exist. The nightly
and stable workflows serialize their respective channels throughout publication.
Nightly source promotion uses a fast-forward-only push, so release-only retries cannot
move the branch backward. GitHub release publication waits for CLI and desktop build
success. No publication or service migration occurs merely by preparing a branch.

The final promotion check is installing the published exact version on fresh hosts
and exercising service installation, restart, remote update, and rollback. Local
fixtures cover launcher commit and database rollback, but do not establish systemd,
launchd, or WSL behavior on real destination hosts. See the [migration instructions](../user/background-service.md#migrating-an-existing-styal-installation).

## Standalone archives

Fork Nightly and Fork Release additionally build `styal-<version>-<platform>-<arch>`
archives and attach `SHA256SUMS`. The native matrix covers macOS arm64, Linux
x64/arm64, and Windows x64/arm64. Intel macOS is unsupported. Each archive contains
the executable, web client, license, native dependencies, and resource monitor.
Node and native build tools are needed on the build runner, not the destination.
Provider CLIs may still need their own Node installation.

Fork Nightly and Fork Release build the server bundle, web client, and Electron
main once, then start each desktop target and the CLI archive matrix from that
bundle. Each executable is built and verified on its own architecture. Windows
desktop packaging embeds a Linux x64 archive for WSL. The Windows target builds its
own copy so it does not wait for the five-platform archive matrix; distinct artifact
names keep release assets from the full matrix. Building an archive does not migrate
an installed service.

To verify a local Linux x64 archive (with `.scratch/` ignored):

```sh
vp run --filter ./apps/server build
VP_NODE_VERSION=26.12.1 node apps/server/scripts/cli.ts build-exe --verbose
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
mkdir -p .scratch/cli-resource-monitor/linux-x64
cp native/resource-monitor/target/release/styal-resource-monitor .scratch/cli-resource-monitor/linux-x64/
VP_NODE_VERSION=26.12.1 node scripts/build-cli-archive.ts --platform linux --arch x64 --version <version> --resource-monitor-dir .scratch/cli-resource-monitor --output-dir .scratch/cli-archives
VP_NODE_VERSION=26.12.1 node scripts/smoke-cli-archive.mjs .scratch/cli-archives/styal-<version>-linux-x64.tar.gz <version>
```

Use the version compiled into the executable. Release workflows align package
versions before building. Keep the archive builder and verifier on the same Node
version as the executable so native addon verification uses the matching ABI.
The smoke check extracts into synthetic scratch state, runs without Node on PATH,
opens a bundled terminal, pairs a client, reads its authenticated project snapshot,
and verifies persistence after restart. On service-supported platforms it also
starts the embedded launcher, verifies its IPC-managed child, and shuts both down.
Logs remain in the reported scratch path.

macOS release archives use the fork's Developer ID certificate and notarization
credentials; local builds use ad hoc signing. Windows archives follow the fork's
unsigned Windows release policy unless Azure Trusted Signing is explicitly
configured. Checksums are generated only after every target's verification passes,
and cover the final archive bytes after signing.
