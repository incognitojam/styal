// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import CurrentForkMigration0001 from "../src/persistence/ForkMigrations/001_ComposerDrafts.ts";
import * as CurrentForkMigrations from "../src/persistence/ForkMigrations.ts";
import * as CurrentMigrations from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";

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

const insertDraft = Effect.fn("insertNightlyUpgradeDraft")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO composer_drafts (
      thread_id,
      revision,
      common_json,
      updated_at,
      client_mutation_id
    ) VALUES (
      ${threadId},
      1,
      '{"text":"upgrade fixture"}',
      '2026-01-01T00:00:00.000Z',
      'fixture-write'
    )
  `;
});

const readDraft = Effect.fn("readNightlyUpgradeDraft")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly thread_id: string; readonly common_json: string | null }>`
    SELECT thread_id, common_json
    FROM composer_drafts
    WHERE thread_id = ${threadId}
  `;
  return rows.map(({ thread_id, common_json }) => ({ thread_id, common_json }));
});

const runOnDatabase = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })))),
  );

const assertCurrentState = async (
  databasePath: string,
  threadId: string,
  expectedRepair: boolean,
): Promise<void> => {
  const state = await runOnDatabase(
    databasePath,
    Effect.gen(function* () {
      const firstRun = yield* CurrentForkMigrations.runAllMigrations();
      const histories = yield* readHistories();
      const draft = yield* readDraft(threadId);
      const secondRun = yield* CurrentForkMigrations.runAllMigrations();
      return { firstRun, histories, draft, secondRun } as const;
    }),
  );

  NodeAssert.equal(state.firstRun.repairedLegacyHistory, expectedRepair);
  NodeAssert.deepStrictEqual(
    state.histories.upstream,
    manifestRows(CurrentMigrations.migrationManifest),
  );
  NodeAssert.deepStrictEqual(
    state.histories.fork,
    manifestRows(CurrentForkMigrations.forkMigrationManifest),
  );
  NodeAssert.deepStrictEqual(state.draft, [
    { thread_id: threadId, common_json: '{"text":"upgrade fixture"}' },
  ]);
  NodeAssert.deepStrictEqual(state.secondRun, {
    upstream: [],
    fork: [],
    repairedLegacyHistory: false,
  });
};

const runChecked = (
  executable: string,
  args: ReadonlyArray<string>,
  input?: Uint8Array,
): Buffer => {
  const result = NodeChildProcess.spawnSync(executable, args, {
    cwd: repoRoot,
    maxBuffer: 20 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed: ${result.stderr?.toString().trim() || "unknown error"}`,
    );
  }
  return result.stdout;
};

const tempRoot = NodeFS.mkdtempSync(NodePath.join(repoRoot, ".nightly-schema-upgrade-"));

try {
  runChecked("git", ["rev-parse", "--verify", `${previousRef}^{commit}`]);
  const archive = runChecked("git", [
    "archive",
    "--format=tar",
    previousRef,
    "--",
    "apps/server/src/persistence",
  ]);
  runChecked("tar", ["-xf", "-", "-C", tempRoot], archive);
  NodeFS.symlinkSync(
    NodePath.join(repoRoot, "apps/server/node_modules"),
    NodePath.join(tempRoot, "apps/server/node_modules"),
    "dir",
  );

  const previousPersistenceRoot = NodePath.join(tempRoot, "apps/server/src/persistence");
  const previousMigrations: typeof CurrentMigrations = await import(
    NodeURL.pathToFileURL(NodePath.join(previousPersistenceRoot, "Migrations.ts")).href
  );
  const previousForkMigrations: typeof CurrentForkMigrations = await import(
    NodeURL.pathToFileURL(NodePath.join(previousPersistenceRoot, "ForkMigrations.ts")).href
  );
  const previousForkMigration0001: typeof CurrentForkMigration0001 = (
    await import(
      NodeURL.pathToFileURL(
        NodePath.join(previousPersistenceRoot, "ForkMigrations/001_ComposerDrafts.ts"),
      ).href
    )
  ).default;

  const splitDatabasePath = NodePath.join(tempRoot, "post-split.sqlite");
  const previousSplitState = await runOnDatabase(
    splitDatabasePath,
    Effect.gen(function* () {
      yield* previousForkMigrations.runAllMigrations();
      yield* insertDraft("post-split-thread");
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
  await assertCurrentState(splitDatabasePath, "post-split-thread", false);

  const legacyDatabasePath = NodePath.join(tempRoot, "legacy-pre-split.sqlite");
  await runOnDatabase(
    legacyDatabasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* previousMigrations.runMigrations({ toMigrationInclusive: 38 });
      yield* previousForkMigration0001;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (39, 'ComposerDrafts')
      `;
      yield* insertDraft("legacy-pre-split-thread");
    }),
  );
  await assertCurrentState(legacyDatabasePath, "legacy-pre-split-thread", true);

  process.stdout.write(`Verified schema upgrades from ${previousRef} (post-split and legacy).\n`);
} finally {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
}
