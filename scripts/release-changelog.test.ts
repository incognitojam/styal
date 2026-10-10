// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const helperPath = NodePath.resolve(repoRoot, ".github/scripts/release-changelog.sh");

function createFixture(): string {
  const scratchRoot = NodePath.join(repoRoot, ".scratch");
  NodeFS.mkdirSync(scratchRoot, { recursive: true });
  const fixtureRoot = NodeFS.mkdtempSync(NodePath.join(scratchRoot, "release-changelog-test-"));
  runGit(fixtureRoot, "init");
  runGit(fixtureRoot, "config", "user.name", "Release Changelog Test");
  runGit(fixtureRoot, "config", "user.email", "release-changelog@example.com");
  return fixtureRoot;
}

function runGit(cwd: string, ...args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function commitFile(cwd: string, fileName: string, contents: string, subject: string): string {
  NodeFS.writeFileSync(NodePath.join(cwd, fileName), contents);
  runGit(cwd, "add", fileName);
  runGit(cwd, "commit", "-m", subject);
  return runGit(cwd, "rev-parse", "HEAD");
}

function commitPaths(cwd: string, paths: ReadonlyArray<string>, subject: string): string {
  for (const path of paths) {
    const filePath = NodePath.join(cwd, path);
    NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
    NodeFS.writeFileSync(filePath, `${subject}\n`);
    runGit(cwd, "add", path);
  }
  runGit(cwd, "commit", "-m", subject);
  return runGit(cwd, "rev-parse", "HEAD");
}

function commitFiles(
  cwd: string,
  files: Readonly<Record<string, string>>,
  message: string,
): string {
  for (const [path, contents] of Object.entries(files)) {
    const filePath = NodePath.join(cwd, path);
    NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
    NodeFS.writeFileSync(filePath, contents);
    runGit(cwd, "add", path);
  }
  runGit(cwd, "commit", "-m", message);
  return runGit(cwd, "rev-parse", "HEAD");
}

function listForkReleaseCommits(
  cwd: string,
  previousReleaseRef: string,
  forkSourceRef: string,
  upstreamRef: string,
): ReadonlyArray<string> {
  const result = NodeChildProcess.spawnSync(
    "bash",
    [
      "-c",
      'source "$1" || exit 2; list_fork_release_commits "$2" "$3" "$4"',
      "release-changelog-test",
      helperPath,
      previousReleaseRef,
      forkSourceRef,
      upstreamRef,
    ],
    { cwd, encoding: "utf8" },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Listing fork release commits failed: ${result.stderr}`);
  }
  return result.stdout.trim() === "" ? [] : result.stdout.trim().split("\n");
}

it("does not attribute upstream commits to the fork after a rebase", () => {
  const fixtureRoot = createFixture();

  try {
    commitFile(fixtureRoot, "base.txt", "base\n", "feat: base");
    runGit(fixtureRoot, "switch", "-c", "previous-release");
    commitFile(fixtureRoot, "fork-one.txt", "fork one\n", "feat(fork): first change (#1)");
    runGit(fixtureRoot, "tag", "previous-release-tag");

    runGit(fixtureRoot, "switch", "-c", "upstream", "HEAD~1");
    const upstreamCommit = commitFile(
      fixtureRoot,
      "upstream.txt",
      "upstream\n",
      "feat(web): upstream change (#5000)",
    );

    runGit(fixtureRoot, "switch", "-c", "fork-source", "previous-release-tag");
    runGit(fixtureRoot, "rebase", "upstream");
    const rebasedForkCommit = runGit(fixtureRoot, "rev-parse", "HEAD");
    const forkCommit = commitFile(
      fixtureRoot,
      "fork-two.txt",
      "fork two\n",
      "feat(fork): second change (#2)",
    );

    const commits = listForkReleaseCommits(
      fixtureRoot,
      "previous-release-tag",
      "fork-source",
      "upstream",
    );

    assert.deepEqual(commits, [forkCommit]);
    assert.equal(commits.includes(upstreamCommit), false);
    assert.deepEqual(listForkReleaseCommits(fixtureRoot, "", "fork-source", "upstream"), [
      rebasedForkCommit,
      forkCommit,
    ]);
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

it.each([
  {
    name: "fork pull request",
    message: "fix: synthetic change (#42)",
    lookupOutput: "release-author",
    lookupStatus: 0,
    pullRepository: "example/fork",
    author: "release-author",
  },
  {
    name: "cherry-picked upstream pull request",
    message: "fix: synthetic change (#42)\n\nUpstream-PR: 42",
    lookupOutput: "upstream-author",
    lookupStatus: 0,
    pullRepository: "pingdotgg/t3code",
    author: "upstream-author",
  },
  {
    name: "comma-separated upstream provenance",
    message: "fix: synthetic change (#42)\n\nupstream-pr: 41, 42",
    lookupOutput: "upstream-author",
    lookupStatus: 0,
    pullRepository: "pingdotgg/t3code",
    author: "upstream-author",
  },
  {
    name: "fork squash with a distinct upstream source PR",
    message: "fix: synthetic change (#42)\n\nUpstream-PR: 142",
    lookupOutput: "release-author",
    lookupStatus: 0,
    pullRepository: "example/fork",
    author: "release-author",
  },
  {
    name: "404 response body on stdout",
    message: "fix: synthetic change (#42)\n\nUpstream-PR: 42",
    lookupOutput:
      '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/pulls/pulls#get-a-pull-request","status":"404"}',
    lookupStatus: 1,
    pullRepository: "pingdotgg/t3code",
    author: "",
  },
  {
    name: "rate-limited lookup",
    message: "fix: synthetic change (#42)",
    lookupOutput: '{"message":"API rate limit exceeded","status":"403"}',
    lookupStatus: 1,
    pullRepository: "example/fork",
    author: "",
  },
  {
    name: "missing author",
    message: "fix: synthetic change (#42)",
    lookupOutput: "",
    lookupStatus: 0,
    pullRepository: "example/fork",
    author: "",
  },
  {
    name: "malformed author",
    message: "fix: synthetic change (#42)",
    lookupOutput: '{"message":"unexpected response"}',
    lookupStatus: 0,
    pullRepository: "example/fork",
    author: "",
  },
  {
    name: "bot author",
    message: "fix: synthetic change (#42)",
    lookupOutput: "release-bot[bot]",
    lookupStatus: 0,
    pullRepository: "example/fork",
    author: "release-bot[bot]",
  },
  {
    name: "commit without a pull request",
    message: "fix: synthetic change",
    lookupOutput: "",
    lookupStatus: 0,
    pullRepository: "",
    author: "",
  },
])("renders $name", ({ message, lookupOutput, lookupStatus, pullRepository, author }) => {
  const fixtureRoot = createFixture();
  try {
    const sha = commitFile(fixtureRoot, "change.txt", "synthetic change\n", message);
    const lookupLog = NodePath.join(fixtureRoot, "lookups.txt");
    NodeFS.writeFileSync(lookupLog, "");
    const result = NodeChildProcess.spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
source "$1"
lookup_output="$3"
lookup_status="$4"
lookup_log="$5"
gh() {
  printf '%s\\n' "$2" >> "$lookup_log"
  printf '%s\\n' "$lookup_output"
  return "$lookup_status"
}
append_release_changes example/fork "$2"`,
        "release-changelog-test",
        helperPath,
        sha,
        lookupOutput,
        String(lookupStatus),
        lookupLog,
      ],
      { cwd: fixtureRoot, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    const subject = message.split("\n")[0];
    const expected =
      lookupStatus === 0 && pullRepository !== ""
        ? `- fix: synthetic change ([${pullRepository}#42](https://github.com/${pullRepository}/pull/42))${author === "" ? "" : ` by @${author}`}\n`
        : `- ${subject} ([\`${sha.slice(0, 7)}\`](https://github.com/example/fork/commit/${sha}))\n`;
    assert.equal(result.stdout, expected);
    assert.equal(
      NodeFS.readFileSync(lookupLog, "utf8"),
      pullRepository === "" ? "" : `repos/${pullRepository}/pulls/42\n`,
    );
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

it("keeps repository attribution local to each entry in a mixed release", () => {
  const fixtureRoot = createFixture();
  try {
    const upstreamSha = commitFile(
      fixtureRoot,
      "upstream.txt",
      "upstream change\n",
      "fix: upstream change (#42)\n\nUpstream-PR: 42",
    );
    const forkSha = commitFile(fixtureRoot, "fork.txt", "fork change\n", "fix: fork change (#43)");
    const result = NodeChildProcess.spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
source "$1"
gh() { printf 'release-author\\n'; }
append_release_changes example/fork
append_release_changes example/fork "$2" "$3"`,
        "release-changelog-test",
        helperPath,
        upstreamSha,
        forkSha,
      ],
      { cwd: fixtureRoot, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      "- fix: upstream change ([pingdotgg/t3code#42](https://github.com/pingdotgg/t3code/pull/42)) by @release-author\n" +
        "- fix: fork change ([example/fork#43](https://github.com/example/fork/pull/43)) by @release-author\n",
    );
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

it.each([
  { paths: ["apps/web/src/components/Sidebar.tsx"], shipped: true },
  { paths: ["apps/server/src/provider/Layers/CodexAdapter.ts"], shipped: true },
  { paths: ["apps/mobile/app.config.ts"], shipped: true },
  { paths: ["apps/desktop/package.json"], shipped: true },
  { paths: ["packages/contracts/src/settings.ts"], shipped: true },
  { paths: ["patches/effect@4.0.0-rc.112.patch", "pnpm-lock.yaml"], shipped: true },
  { paths: ["pnpm-lock.yaml"], shipped: true },
  { paths: ["pnpm-workspace.yaml"], shipped: true },
  { paths: ["package.json"], shipped: false },
  { paths: ["docs/operations/fork-nightly.md", "apps/web/src/main.tsx"], shipped: true },
  { paths: ["docs/operations/fork-nightly.md"], shipped: false },
  { paths: [".github/workflows/fork-nightly.yml"], shipped: false },
  { paths: ["AGENTS.md", "scripts/release-smoke.ts"], shipped: false },
  { paths: ["apps/marketing/src/pages/index.astro"], shipped: false },
  { paths: ["infra/relay/src/agentActivity/ApnsDeliveries.ts"], shipped: false },
  { paths: ["apps/server/README.md"], shipped: false },
  { paths: ["apps/web/src/components/Sidebar.test.tsx"], shipped: false },
  { paths: ["apps/desktop/scripts/electron-launcher.test.mjs"], shipped: false },
  { paths: ["apps/server/src/testUtils/fakeCli.ts"], shipped: false },
  { paths: ["apps/server/src/dataImport/testFixtures/t3-code/state.sql"], shipped: false },
  { paths: ["apps/server/integration/TransferBudgetReport.integration.ts"], shipped: false },
  { paths: ["apps/server/scripts/fake-codex.ts"], shipped: false },
  { paths: ["packages/shared/src/testing/longTempDir.ts"], shipped: false },
])("treats a commit changing $paths as shipped: $shipped", ({ paths, shipped }) => {
  const fixtureRoot = createFixture();
  try {
    const sha = commitPaths(fixtureRoot, paths, "fix: synthetic change");
    const result = NodeChildProcess.spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; changes_shipped_code "$2"',
        "release-changelog-test",
        helperPath,
        sha,
      ],
      { cwd: fixtureRoot, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    assert.equal(result.stderr, "");
    assert.equal(result.status, shipped ? 0 : 1);
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function renderReleaseNotes(
  cwd: string,
  previousTag: string,
  newTag: string,
  forkSourceRef: string,
  upstreamRef: string,
): string {
  const result = NodeChildProcess.spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
source "$1"
gh() { printf 'release-author\\n'; }
render_release_notes example/fork "$2" "$3" "$4" "$5"`,
      "release-changelog-test",
      helperPath,
      previousTag,
      newTag,
      forkSourceRef,
      upstreamRef,
    ],
    { cwd, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Rendering release notes failed: ${result.stderr}`);
  }
  return result.stdout;
}

it.each([
  {
    name: "mobile version bookkeeping",
    before: { "apps/mobile/app.config.ts": 'const config = {\n  version: "1.0.0",\n};\n' },
    after: { "apps/mobile/app.config.ts": 'const config = {\n  version: "1.0.1",\n};\n' },
    message: "chore(mobile): bump app version",
    listed: false,
  },
  {
    name: "package prerelease version bookkeeping",
    before: { "packages/shared/package.json": '{\n  "version": "1.0.0-nightly.1"\n}\n' },
    after: { "packages/shared/package.json": '{\n  "version": "1.0.0-nightly.2"\n}\n' },
    message: "chore(release): prepare nightly",
    listed: false,
  },
  {
    name: "version bump with dependency changes",
    before: {
      "apps/server/package.json":
        '{\n  "version": "1.0.0",\n  "dependencies": { "synthetic-dependency": "1.0.0" }\n}\n',
    },
    after: {
      "apps/server/package.json":
        '{\n  "version": "1.0.1",\n  "dependencies": { "synthetic-dependency": "1.0.1" }\n}\n',
    },
    message: "chore(release): prepare release",
    listed: true,
  },
  {
    name: "version bump with runtime config changes",
    before: {
      "apps/mobile/app.config.ts": 'const config = {\n  version: "1.0.0",\n  scheme: "old",\n};\n',
    },
    after: {
      "apps/mobile/app.config.ts": 'const config = {\n  version: "1.0.1",\n  scheme: "new",\n};\n',
    },
    message: "chore(mobile): bump app version",
    listed: true,
  },
  {
    name: "version bump with runtime edits",
    before: {
      "apps/mobile/app.config.ts": 'version: "1.0.0",\n',
      "apps/mobile/src/update.ts": "export const supported = false;\n",
    },
    after: {
      "apps/mobile/app.config.ts": 'version: "1.0.1",\n',
      "apps/mobile/src/update.ts": "export const supported = true;\n",
    },
    message: "chore(mobile): bump app version",
    listed: true,
  },
  {
    name: "version bump with a dependency lockfile change",
    before: { "apps/mobile/app.config.ts": 'version: "1.0.0",\n', "pnpm-lock.yaml": "old\n" },
    after: { "apps/mobile/app.config.ts": 'version: "1.0.1",\n', "pnpm-lock.yaml": "new\n" },
    message: "chore(mobile): bump app version",
    listed: true,
  },
  {
    name: "new package manifest",
    before: { "base.txt": "synthetic base\n" },
    after: { "packages/shared/package.json": '{\n  "version": "1.0.0"\n}\n' },
    message: "feat: add package",
    listed: true,
  },
  {
    name: "adding a manifest version field",
    before: { "apps/desktop/package.json": '{\n  "name": "synthetic-package"\n}\n' },
    after: {
      "apps/desktop/package.json": '{\n  "version": "1.0.0",\n  "name": "synthetic-package"\n}\n',
    },
    message: "fix(desktop): give packaged builds a version",
    listed: true,
  },
  {
    name: "removing a manifest version field",
    before: {
      "apps/desktop/package.json": '{\n  "version": "1.0.0",\n  "name": "synthetic-package"\n}\n',
    },
    after: { "apps/desktop/package.json": '{\n  "name": "synthetic-package"\n}\n' },
    message: "chore(desktop): remove version field",
    listed: true,
  },
  {
    name: "lint-labelled runtime fixes",
    before: { "apps/web/src/index.css": ".focus { color: red; }\n" },
    after: { "apps/web/src/index.css": ".focus { color: blue; }\n" },
    message: "lint/unknown and static",
    listed: true,
  },
  {
    name: "refactor-labelled navigation changes",
    before: { "apps/web/src/navigation.ts": 'export const location = "settings";\n' },
    after: { "apps/web/src/navigation.ts": 'export const location = "breadcrumbs";\n' },
    message: "refactor(web): move settings scope pickers into breadcrumbs",
    listed: true,
  },
  {
    name: "explicit opt out",
    before: { "apps/web/src/navigation.ts": "export const unused = false;\n" },
    after: { "apps/web/src/navigation.ts": "const unused = false;\n" },
    message: "chore: clean up unused exports\n\nRelease-Note: skip",
    listed: false,
  },
  {
    name: "explicit opt in for a version-only change",
    before: { "apps/mobile/app.config.ts": 'version: "1.0.0",\n' },
    after: { "apps/mobile/app.config.ts": 'version: "1.0.1",\n' },
    message: "chore(mobile): bump app version\n\nRelease-Note: include",
    listed: true,
  },
  {
    name: "unknown override",
    before: { "apps/web/src/navigation.ts": "export const supported = false;\n" },
    after: { "apps/web/src/navigation.ts": "export const supported = true;\n" },
    message: "fix: restore navigation\n\nRelease-Note: skpi",
    listed: true,
  },
  {
    name: "ambiguous overrides",
    before: { "apps/web/src/navigation.ts": "export const supported = false;\n" },
    after: { "apps/web/src/navigation.ts": "export const supported = true;\n" },
    message: "fix: restore navigation\n\nRelease-Note: skip\nRelease-Note: include",
    listed: true,
  },
])("filters $name without changing release eligibility", ({ before, after, message, listed }) => {
  const fixtureRoot = createFixture();
  try {
    commitFiles(fixtureRoot, before, "feat: synthetic base");
    const sha = commitFiles(fixtureRoot, after, message);
    const result = NodeChildProcess.spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
source "$1"
changes_shipped_code "$2"
range_changes_shipped_code "$2^" "$2"
if should_list_release_change "$2"; then printf 'listed'; else printf 'omitted'; fi`,
        "release-changelog-test",
        helperPath,
        sha,
      ],
      { cwd: fixtureRoot, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, listed ? "listed" : "omitted");
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

it("counts omitted fork and upstream notes and retains explicit inclusions", () => {
  const fixtureRoot = createFixture();
  try {
    commitFiles(
      fixtureRoot,
      {
        "apps/mobile/app.config.ts": 'version: "1.0.0",\n',
        "apps/web/src/navigation.ts": "export const unused = true;\n",
      },
      "feat: synthetic base",
    );
    runGit(fixtureRoot, "tag", "previous-release");
    runGit(fixtureRoot, "switch", "-c", "upstream");
    commitFiles(
      fixtureRoot,
      { "apps/mobile/app.config.ts": 'version: "1.0.1",\n' },
      "chore(mobile): bump version (#5001)",
    );

    runGit(fixtureRoot, "switch", "-c", "fork-source");
    commitFiles(
      fixtureRoot,
      { "apps/web/src/navigation.ts": "const unused = true;\n" },
      "chore: remove unused export (#11)\n\nRelease-Note: skip",
    );
    commitFiles(
      fixtureRoot,
      { "apps/mobile/app.config.ts": 'version: "1.0.2",\n' },
      "chore(mobile): announce binary version (#12)\n\nRelease-Note: include",
    );

    assert.equal(
      renderReleaseNotes(fixtureRoot, "previous-release", "new-release", "fork-source", "upstream"),
      "## What's Changed\n\n" +
        "- chore(mobile): announce binary version ([example/fork#12](https://github.com/example/fork/pull/12)) by @release-author\n" +
        "\n**Full Changelog**: https://github.com/example/fork/compare/previous-release...new-release" +
        " (includes 2 additional changes not listed above)\n",
    );
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

it("does not claim a version-only build has no behavior changes", () => {
  const fixtureRoot = createFixture();
  try {
    commitFiles(
      fixtureRoot,
      { "apps/mobile/app.config.ts": 'version: "1.0.0",\n' },
      "feat: synthetic base",
    );
    runGit(fixtureRoot, "tag", "previous-release");
    runGit(fixtureRoot, "branch", "upstream");
    commitFiles(
      fixtureRoot,
      { "apps/mobile/app.config.ts": 'version: "1.0.1",\n' },
      "chore(mobile): bump app version",
    );
    assert.equal(
      renderReleaseNotes(fixtureRoot, "previous-release", "new-release", "HEAD", "upstream"),
      "## What's Changed\n\nNo release-note entries.\n" +
        "\n**Full Changelog**: https://github.com/example/fork/compare/previous-release...new-release" +
        " (includes 1 additional change not listed above)\n",
    );
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

it("lists only fork and upstream changes to shipped code and counts the rest", () => {
  const fixtureRoot = createFixture();
  try {
    commitPaths(fixtureRoot, ["apps/web/src/main.tsx"], "feat: base");
    runGit(fixtureRoot, "tag", "previous-release");

    runGit(fixtureRoot, "switch", "-c", "upstream");
    commitPaths(fixtureRoot, ["apps/server/src/server.ts"], "fix(server): upstream fix (#5001)");
    commitPaths(fixtureRoot, [".github/workflows/ci.yml"], "ci: upstream workflow (#5002)");

    runGit(fixtureRoot, "switch", "-c", "fork-source");
    commitPaths(fixtureRoot, ["docs/operations/release.md"], "docs(release): fork docs (#11)");
    commitPaths(fixtureRoot, ["apps/web/src/Sidebar.tsx"], "fix(web): fork fix (#12)");
    commitPaths(
      fixtureRoot,
      [".github/workflows/fork-nightly.yml", "apps/desktop/src/main.ts"],
      "ci(release): fork packaging change (#13)",
    );
    commitPaths(fixtureRoot, ["apps/web/src/Sidebar.test.tsx"], "test(web): fork test (#14)");

    assert.equal(
      renderReleaseNotes(fixtureRoot, "previous-release", "new-release", "fork-source", "upstream"),
      "## What's Changed\n\n" +
        "- fix(web): fork fix ([example/fork#12](https://github.com/example/fork/pull/12)) by @release-author\n" +
        "- ci(release): fork packaging change ([example/fork#13](https://github.com/example/fork/pull/13)) by @release-author\n" +
        "- fix(server): upstream fix ([pingdotgg/t3code#5001](https://github.com/pingdotgg/t3code/pull/5001)) by @release-author\n" +
        "\n**Full Changelog**: https://github.com/example/fork/compare/previous-release...new-release" +
        " (includes 3 additional changes not listed above)\n",
    );
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

it("says there are no release-note entries when every commit is internal", () => {
  const fixtureRoot = createFixture();
  try {
    commitPaths(fixtureRoot, ["apps/web/src/main.tsx"], "feat: base");
    runGit(fixtureRoot, "tag", "previous-release");
    runGit(fixtureRoot, "branch", "upstream");
    commitPaths(fixtureRoot, ["AGENTS.md"], "docs(agents): fork guidance (#11)");

    assert.equal(
      renderReleaseNotes(fixtureRoot, "previous-release", "new-release", "HEAD", "upstream"),
      "## What's Changed\n\n" +
        "No release-note entries.\n" +
        "\n**Full Changelog**: https://github.com/example/fork/compare/previous-release...new-release" +
        " (includes 1 additional change not listed above)\n",
    );
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function latestStableTag(cwd: string, before = ""): string {
  const result = NodeChildProcess.spawnSync(
    "bash",
    [
      "-c",
      'source "$1" || exit 2; latest_stable_tag "$2"',
      "release-changelog-test",
      helperPath,
      before,
    ],
    { cwd, encoding: "utf8" },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Resolving the latest stable tag failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

it("resolves the latest stable tag by version, ignoring prerelease tags", () => {
  const fixtureRoot = createFixture();

  try {
    commitFile(fixtureRoot, "base.txt", "base\n", "feat: base");
    for (const tag of [
      "v0.1.0-nightly.20260901.1",
      "v0.9.0",
      "v0.10.0",
      "v0.10.1",
      "v0.11.0-nightly.20260926.4",
      "v0.11.0-rc.1",
    ]) {
      runGit(fixtureRoot, "tag", tag);
    }

    assert.equal(latestStableTag(fixtureRoot), "v0.10.1");
    assert.equal(latestStableTag(fixtureRoot, "v0.10.1"), "v0.10.0");
    assert.equal(latestStableTag(fixtureRoot, "v0.11.0"), "v0.10.1");
    assert.equal(latestStableTag(fixtureRoot, "v0.9.0"), "");
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

it("resolves no latest stable tag before the first stable release", () => {
  const fixtureRoot = createFixture();

  try {
    commitFile(fixtureRoot, "base.txt", "base\n", "feat: base");
    runGit(fixtureRoot, "tag", "v0.1.0-nightly.20260926.420");

    assert.equal(latestStableTag(fixtureRoot), "");
    assert.equal(latestStableTag(fixtureRoot, "v0.1.0"), "");
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

it.each([
  {
    paths: [[".github/actions/setup-deps/action.yml"], ["docs/operations/fork-nightly.md"]],
    shipped: false,
  },
  { paths: [["docs/operations/fork-nightly.md"], ["apps/web/src/main.tsx"]], shipped: true },
])("finds shipped code in a range of $paths: $shipped", ({ paths, shipped }) => {
  const fixtureRoot = createFixture();
  try {
    const from = commitFile(fixtureRoot, "base.txt", "base\n", "feat: base");
    const commits = paths.map((changed) => commitPaths(fixtureRoot, changed, "chore: change"));
    const result = NodeChildProcess.spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; range_changes_shipped_code "$2" "$3"',
        "release-changelog-test",
        helperPath,
        from,
        commits.at(-1) ?? from,
      ],
      { cwd: fixtureRoot, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    assert.equal(result.stderr, "");
    assert.equal(result.status, shipped ? 0 : 1);
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
