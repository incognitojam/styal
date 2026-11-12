// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";

export function vitePlusCommand(
  args: ReadonlyArray<string>,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node tooling has no Effect runtime; tests pass the platform explicitly.
  platform: NodeJS.Platform = process.platform,
): [command: string, args: Array<string>] {
  // Windows cannot spawn the package manager's vp.cmd shim without a shell.
  // Use Vite+'s exported JS entry with this Node instead, keeping paths and
  // arguments literal. Resolve here, not from the patch check's temporary cwd.
  if (platform === "win32") {
    return [
      process.execPath,
      [NodeURL.fileURLToPath(import.meta.resolve("vite-plus/bin")), ...args],
    ];
  }
  return ["vp", [...args]];
}

export function repositoryChecks(files: ReadonlyArray<string>, ledgerPaths: ReadonlyArray<string>) {
  const ledgerSources = [
    ".github/fork-features.yml",
    "scripts/fork-feature-ledger.ts",
    "scripts/check-fork-feature-ledger.ts",
  ];
  const ledgerChanged = files.some((file) => ledgerSources.includes(file));
  return {
    ledger: ledgerChanged || files.some((file) => ledgerPaths.includes(file)),
    naming: files.some(
      (file) =>
        /^(?:apps\/[^/]+\/src\/|apps\/mobile\/(?:modules|plugins)\/|apps\/desktop\/gnome-extension\/|packages\/[^/]+\/src\/)/u.test(
          file,
        ) ||
        [
          "apps/mobile/app.config.ts",
          "scripts/build-desktop-artifact.ts",
          "scripts/upstream-naming.ts",
          "scripts/check-upstream-naming.ts",
        ].includes(file),
    ),
    migrations: files.some(
      (file) =>
        /^apps\/server\/src\/persistence\/Migrations(?:\/|\.ts$)/u.test(file) ||
        [
          "scripts/upstream/check-migrations.ts",
          "scripts/upstream/migration-git.ts",
          "scripts/upstream/lib/migrations.ts",
        ].includes(file),
    ),
    tests: [
      ...(ledgerChanged
        ? [
            "scripts/fork-feature-ledger.test.ts",
            "apps/web/src/components/settings/forkFeatures.test.ts",
          ]
        : []),
      ...(files.includes(".github/scripts/superseded-dependency-caches.jq")
        ? [".github/scripts/superseded-dependency-caches.test.cjs"]
        : []),
      ...(files.includes("knip.jsonc") ? ["scripts/knip-schemas.test.ts"] : []),
      ...(files.includes(".github/workflows/provider-canary.yml")
        ? ["scripts/provider-canary.test.ts"]
        : []),
    ],
  };
}
