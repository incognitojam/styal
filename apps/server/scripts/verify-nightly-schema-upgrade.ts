// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as CurrentForkMigrations from "../src/persistence/ForkMigrations.ts";
import * as CurrentMigrations from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);
const previousRef = process.argv.slice(2).find((argument) => argument !== "--");

if (!previousRef) {
  throw new Error("Usage: verify-nightly-schema-upgrade.ts <previous-nightly-ref>");
}

interface MigrationHistoryRow {
  readonly migration_id: number;
  readonly name: string;
}

interface Histories {
  readonly upstream: ReadonlyArray<MigrationHistoryRow>;
  readonly fork: ReadonlyArray<MigrationHistoryRow>;
}

const manifestRows = (
  manifest: ReadonlyArray<readonly [number, string]>,
): ReadonlyArray<MigrationHistoryRow> =>
  manifest.map(([migration_id, name]) => ({ migration_id, name }));

const readHistories = Effect.fn("readNightlyUpgradeHistories")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const upstream = yield* sql<MigrationHistoryRow>`
    SELECT migration_id, name
    FROM effect_sql_migrations
    ORDER BY migration_id
  `;
  const fork = yield* sql<MigrationHistoryRow>`
    SELECT migration_id, name
    FROM yngatech_sql_migrations
    ORDER BY migration_id
  `;
  return {
    upstream: upstream.map(({ migration_id, name }) => ({ migration_id, name })),
    fork: fork.map(({ migration_id, name }) => ({ migration_id, name })),
  } satisfies Histories;
});

const insertPortAllocation = Effect.fn("insertNightlyUpgradePortAllocation")(function* (
  workspacePath: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO workspace_port_allocations (workspace_path, base_port)
    VALUES (${workspacePath}, 20010)
  `;
});

const readPortAllocation = Effect.fn("readNightlyUpgradePortAllocation")(function* (
  workspacePath: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly workspace_path: string; readonly base_port: number }>`
    SELECT workspace_path, base_port
    FROM workspace_port_allocations
    WHERE workspace_path = ${workspacePath}
  `;
  return rows.map(({ workspace_path, base_port }) => ({ workspace_path, base_port }));
});

const runOnDatabase = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })))),
  );

const assertCurrentState = async (databasePath: string, workspacePath: string): Promise<void> => {
  const state = await runOnDatabase(
    databasePath,
    Effect.gen(function* () {
      yield* CurrentForkMigrations.runAllMigrations();
      const histories = yield* readHistories();
      const portAllocation = yield* readPortAllocation(workspacePath);
      const secondRun = yield* CurrentForkMigrations.runAllMigrations();
      return { histories, portAllocation, secondRun } as const;
    }),
  );

  NodeAssert.deepStrictEqual(
    state.histories.upstream,
    manifestRows(CurrentMigrations.migrationManifest),
  );
  NodeAssert.deepStrictEqual(
    state.histories.fork,
    manifestRows(CurrentForkMigrations.forkMigrationManifest),
  );
  NodeAssert.deepStrictEqual(state.portAllocation, [
    { workspace_path: workspacePath, base_port: 20010 },
  ]);
  NodeAssert.deepStrictEqual(state.secondRun, {
    upstream: [],
    fork: [],
  });
};

const runChecked = (
  executable: string,
  args: ReadonlyArray<string>,
  input?: Uint8Array,
): Buffer => {
  const result = NodeChildProcess.spawnSync(executable, args, {
    cwd: repoRoot,
    maxBuffer: 128 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed: ${result.stderr?.toString().trim() || "unknown error"}`,
    );
  }
  return result.stdout;
};

const rewriteEffectImports = (directory: string): void => {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      rewriteEffectImports(entryPath);
    } else if (entry.name.endsWith(".ts")) {
      const source = NodeFS.readFileSync(entryPath, "utf8");
      if (!source.includes("effect/unstable/")) continue;
      NodeFS.writeFileSync(
        entryPath,
        source
          .replaceAll("effect/unstable/httpapi", "effect/http-api")
          .replaceAll("effect/unstable/", "effect/"),
      );
    }
  }
};

// Links `source`'s dependencies into `destination`, except that workspace packages resolve to
// the previous nightly's copies under `workspacePackages`. Its server source then imports the
// workspace exports it was written against, even after a later change moves or removes them.
const linkPreviousNodeModules = (
  source: string,
  destination: string,
  workspacePackages: ReadonlyMap<string, string>,
): void => {
  NodeFS.mkdirSync(destination, { recursive: true });
  for (const entry of NodeFS.readdirSync(source)) {
    if (entry !== "@t3tools") {
      NodeFS.symlinkSync(NodePath.join(source, entry), NodePath.join(destination, entry));
      continue;
    }
    NodeFS.mkdirSync(NodePath.join(destination, entry));
    for (const name of NodeFS.readdirSync(NodePath.join(source, entry))) {
      NodeFS.symlinkSync(
        workspacePackages.get(`${entry}/${name}`) ?? NodePath.join(source, entry, name),
        NodePath.join(destination, entry, name),
        "dir",
      );
    }
  }
};

const readWorkspacePackages = (packagesRoot: string): ReadonlyMap<string, string> => {
  const packages = new Map<string, string>();
  for (const entry of NodeFS.readdirSync(packagesRoot, { withFileTypes: true })) {
    const manifestPath = NodePath.join(packagesRoot, entry.name, "package.json");
    if (!entry.isDirectory() || !NodeFS.existsSync(manifestPath)) continue;
    const manifest: { readonly name?: unknown } = JSON.parse(
      NodeFS.readFileSync(manifestPath, "utf8"),
    );
    if (typeof manifest.name === "string") {
      packages.set(manifest.name, NodePath.join(packagesRoot, entry.name));
    }
  }
  return packages;
};

const tempRoot = NodeFS.mkdtempSync(NodePath.join(repoRoot, ".nightly-schema-upgrade-"));

try {
  runChecked("git", ["rev-parse", "--verify", `${previousRef}^{commit}`]);
  const archive = runChecked("git", [
    "archive",
    "--format=tar",
    previousRef,
    "--",
    // Migrations may reuse server code, such as the V1 history conversion fork migration 9
    // re-derives imports with, so the previous nightly's whole server source comes along.
    "apps/server/src",
    "packages",
  ]);
  runChecked("tar", ["-xf", "-", "-C", tempRoot], archive);
  // The previous nightly runs on this checkout's dependencies, so source from before the
  // Effect 4.0 stable release needs its `effect/unstable/*` imports moved to their new paths.
  rewriteEffectImports(NodePath.join(tempRoot, "apps/server/src"));
  rewriteEffectImports(NodePath.join(tempRoot, "packages"));
  const previousPackages = readWorkspacePackages(NodePath.join(tempRoot, "packages"));
  linkPreviousNodeModules(
    NodePath.join(repoRoot, "apps/server/node_modules"),
    NodePath.join(tempRoot, "apps/server/node_modules"),
    previousPackages,
  );
  for (const previousPackage of previousPackages.values()) {
    const currentNodeModules = NodePath.join(
      repoRoot,
      NodePath.relative(tempRoot, previousPackage),
      "node_modules",
    );
    if (NodeFS.existsSync(currentNodeModules)) {
      linkPreviousNodeModules(
        currentNodeModules,
        NodePath.join(previousPackage, "node_modules"),
        previousPackages,
      );
    }
  }

  const previousPersistenceRoot = NodePath.join(tempRoot, "apps/server/src/persistence");
  const previousMigrations: typeof CurrentMigrations = await import(
    NodeURL.pathToFileURL(NodePath.join(previousPersistenceRoot, "Migrations.ts")).href
  );
  const previousForkMigrations: typeof CurrentForkMigrations = await import(
    NodeURL.pathToFileURL(NodePath.join(previousPersistenceRoot, "ForkMigrations.ts")).href
  );
  const splitDatabasePath = NodePath.join(tempRoot, "post-split.sqlite");
  const previousSplitState = await runOnDatabase(
    splitDatabasePath,
    Effect.gen(function* () {
      yield* previousForkMigrations.runAllMigrations();
      yield* insertPortAllocation("/synthetic/post-split-workspace");
      return yield* readHistories();
    }),
  );
  NodeAssert.deepStrictEqual(
    previousSplitState.upstream,
    manifestRows(previousMigrations.migrationManifest),
  );
  NodeAssert.deepStrictEqual(
    previousSplitState.fork,
    manifestRows(previousForkMigrations.forkMigrationManifest),
  );
  await assertCurrentState(splitDatabasePath, "/synthetic/post-split-workspace");

  process.stdout.write(`Verified schema upgrades from ${previousRef}.\n`);
} finally {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
}
