# styal CLI releases

Fork Nightly and Fork Release build five standalone archives, then turn those exact
bytes into npm platform packages. `@styal/cli` is a small launcher with exact-version
optional dependencies on `@styal/cli-{darwin-arm64,linux-x64,linux-arm64,win32-x64,win32-arm64}`.
The installed command is `styal`. The npm bridge at `dist/bin.mjs` supports preflight
from older service updaters.

## Build and verify npm packages without publishing

After building the archives described below:

```sh
node scripts/build-npm-platform-packages.ts --archives-dir .scratch/cli-archives --version <version> --output-dir .scratch/cli-npm
docker run --rm \
  -v "$PWD/.scratch/cli-npm/@styal:/artifacts:ro" \
  -v "$PWD/scripts/verify-cli-package.mjs:/verify.mjs:ro" \
  node:26-bookworm node /verify.mjs /artifacts /verification
```

The builder requires all five archives. `--allow-missing` is for local verification
of a partial build only; release workflows never use it. Publish the generated
`.tgz` files, not package directories: npm repacking can omit bundled native files.
Every bundled dependency is declared so later npm installs retain it. Linux
archives target glibc and exclude incompatible musl packages.

The verifier installs with scripts disabled, repeats npm install to check dependency
retention, checks the old protocol 3 preflight refusal, exercises a native terminal,
pairs with the bundled web server, reads a synthetic project, and checks persistence
after restart. It mounts no host state or provider credentials.

## Publication setup

The existing `@styal/cli` package gains five public platform packages. Before enabling
publication for this layout, create those packages and configure trusted publishing
for each one, as well as the launcher. Use owner `incognitojam`, repository `styal`,
and calling workflows `fork-nightly.yml` and `fork-release.yml`. The calling workflow,
not reusable `fork-cli-build.yml`, identifies the OIDC trust relationship. No GitHub
environment is configured. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

With `STYAL_CLI_PUBLISH_ENABLED` unset, CI builds and verifies packages and attaches
all six tarballs to the release without publishing. Dry runs never publish. After
first publication and trust setup, enable that variable. Nightlies use `nightly`;
stable releases use `latest`. The workflow publishes all platform packages before
the launcher, so it never advertises dependencies that have not been published.

npm publication is immutable. Retries accept existing versions only when their registry integrity matches the release tarball. Before publishing or accepting any package, the workflow checks all six packages' channel tags and rejects a target older than any current tag. Registry errors fail closed; missing packages or channel tags allow first publication. The nightly and stable workflows serialize their respective channels throughout publication. Nightly source promotion uses a fast-forward-only push, so release-only retries cannot move the branch backward. GitHub release publication waits for CLI and desktop success.
No publication or service migration occurs merely by preparing a branch.

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

The archive job runs independently of desktop packaging. It shares the web build
across targets and builds and verifies each executable on its own architecture.
Windows desktop packaging consumes the matching Linux archive for WSL. Standalone
Windows builds create that Linux artifact first; other standalone desktop builds do
not need it. Building an archive does not migrate an installed service.

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
and verifies persistence after restart. On service-supported platforms it also
starts the embedded launcher, verifies its IPC-managed child, and shuts both down.
Logs remain in the reported scratch path.

macOS release archives use the fork's Developer ID certificate and notarization
credentials; local builds use ad hoc signing. Windows archives follow the fork's
unsigned Windows release policy unless Azure Trusted Signing is explicitly
configured. Checksums are generated only after every target's verification passes,
and cover the final archive bytes after signing.
