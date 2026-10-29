import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  BUILD_FORK_MIGRATION_HEAD,
  BUILD_MIGRATION_HEAD,
  combinedMigrationHead,
  databaseMigrationHead,
} from "../persistence/databaseMigrationHead.ts";
import { FORK_MIGRATIONS_TABLE, forkMigrationManifest } from "../persistence/ForkMigrations.ts";
import { migrationManifest } from "../persistence/Migrations.ts";

import { runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

it("requires the styal package launcher protocol", () => {
  expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL - 1,
      version: "1.2.3",
    }),
  ).toMatchObject({ status: "blocked", version: "1.2.3" });

  expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      version: "1.2.3",
    }),
  ).toEqual({
    status: "ready",
    version: "1.2.3",
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
  });
});

it.each([1])("blocks legacy launcher protocol %i with exact recovery steps", (launcherProtocol) => {
  const result = runServicePreflight({
    databasePath: "/missing/state.sqlite",
    launcherProtocol,
    version: "9.8.7",
  });

  expect(result).toMatchObject({ status: "blocked", version: "9.8.7" });
  const reason = result.status === "blocked" ? result.reason : "";
  expect(reason).toMatch(new RegExp(`\\b${launcherProtocol}\\b`));
  expect(reason).toMatch(new RegExp(`\\b${SERVICE_LAUNCHER_PROTOCOL}\\b`));
  expect(reason).toContain("npx @styal/cli@9.8.7 service update");
  expect(reason).toContain("styal service update");
  expect(reason).toContain("styal --version");
  expect(reason).toContain("which -a styal");
});

it.layer(NodeServices.layer)("service preflight database", (it) => {
  it.effect("blocks a database that a newer build migrated", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const databasePath = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-preflight-" }),
        "state.sqlite",
      );
      const db = new NodeSqlite.DatabaseSync(databasePath);
      db.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)");
      const insert = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
      for (const [id, name] of migrationManifest) insert.run(id, name);
      const preflight = () =>
        runServicePreflight({ databasePath, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL });

      expect(preflight().status).toBe("ready");
      expect(databaseMigrationHead(databasePath)).toBe(
        combinedMigrationHead(BUILD_MIGRATION_HEAD, BUILD_FORK_MIGRATION_HEAD),
      );
      db.exec(
        `CREATE TABLE ${FORK_MIGRATIONS_TABLE} (migration_id INTEGER PRIMARY KEY, name TEXT)`,
      );
      const insertFork = db.prepare(`INSERT INTO ${FORK_MIGRATIONS_TABLE} VALUES (?, ?)`);
      for (const [id, name] of forkMigrationManifest) insertFork.run(id, name);
      expect(preflight().status).toBe("ready");

      // A fork migration is invisible to upstream's history, so a newer one must block as well.
      const newerForkId = BUILD_FORK_MIGRATION_HEAD + 1;
      insertFork.run(newerForkId, "FromForkNightly");
      const forkResult = preflight();
      expect(forkResult.status).toBe("blocked");
      expect(forkResult.status === "blocked" ? forkResult.reason : "").toContain(
        `${newerForkId}_FromForkNightly`,
      );
      expect(databaseMigrationHead(databasePath)).toBe(
        combinedMigrationHead(BUILD_MIGRATION_HEAD, newerForkId),
      );
      db.exec(`DELETE FROM ${FORK_MIGRATIONS_TABLE} WHERE migration_id = ${newerForkId}`);

      const newerId = Math.max(...migrationManifest.map(([id]) => id)) + 1;
      insert.run(newerId, "FromNightly");
      db.close();
      const result = preflight();
      expect(result.status).toBe("blocked");
      expect(result.status === "blocked" ? result.reason : "").toContain(`${newerId}_FromNightly`);
      // Servers report this head, so clients see a database a newer build migrated.
      expect(databaseMigrationHead(databasePath)).toBe(
        combinedMigrationHead(newerId, BUILD_FORK_MIGRATION_HEAD),
      );

      // A database that exists but cannot be read has an unknown history, so it blocks.
      const unreadable = path.join(path.dirname(databasePath), "unreadable.sqlite");
      yield* fs.writeFileString(unreadable, "not a database");
      expect(databaseMigrationHead(unreadable)).toBeUndefined();
      expect(
        runServicePreflight({
          databasePath: unreadable,
          launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        }).status,
      ).toBe("blocked");
      // A missing database is a fresh install.
      expect(databaseMigrationHead(path.join(path.dirname(databasePath), "missing.sqlite"))).toBe(
        combinedMigrationHead(BUILD_MIGRATION_HEAD, BUILD_FORK_MIGRATION_HEAD),
      );
    }),
  );
});
