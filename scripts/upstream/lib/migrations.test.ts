import { assert, describe, it } from "@effect/vitest";

import {
  changedUpstreamMigrations,
  checkUpstreamMigrationFiles,
  checkUpstreamMigrationManifest,
  checkUpstreamMigrationsAtRevision,
  parseUpstreamMigrationManifest,
  type UpstreamMigrationEntry,
  type UpstreamMigrationGit,
} from "./migrations.ts";

function manifestSource(entries: ReadonlyArray<readonly [number, string]>): string {
  const module = (id: number) => `Migration${String(id).padStart(4, "0")}`;
  const file = (id: number, name: string) => `${String(id).padStart(3, "0")}_${name}.ts`;
  return [
    ...entries.map(([id, name]) => `import ${module(id)} from "./Migrations/${file(id, name)}";`),
    "",
    "const migrationEntries = [",
    ...entries.map(([id, name]) => `  [${id}, "${name}", ${module(id)}],`),
    "] as const;",
  ].join("\n");
}

const upstreamEntries = [
  [50, "ProjectionThreadPullRequests"],
  [51, "ProjectionThreadMessageContext"],
  [52, "ProjectionThreadTitleState"],
] as const;
const upstream = parseUpstreamMigrationManifest(manifestSource(upstreamEntries));

function fork(entries: ReadonlyArray<readonly [number, string]>): UpstreamMigrationEntry[] {
  return [...parseUpstreamMigrationManifest(manifestSource(entries))];
}

describe("upstream migration manifest", () => {
  it("reads IDs, names and the module each entry loads", () => {
    assert.deepEqual(upstream[1], {
      id: 51,
      name: "ProjectionThreadMessageContext",
      path: "apps/server/src/persistence/Migrations/051_ProjectionThreadMessageContext.ts",
    });
    assert.lengthOf(upstream, 3);
  });

  it("accepts a manifest that trails upstream", () => {
    assert.deepEqual(
      checkUpstreamMigrationManifest({ fork: fork(upstreamEntries.slice(0, 2)), upstream }),
      [],
    );
  });

  it("rejects a fork migration that takes an upstream ID", () => {
    const errors = checkUpstreamMigrationManifest({
      fork: fork([
        [50, "ProjectionThreadPullRequests"],
        [51, "ProjectionThreadLatestMessageAt"],
      ]),
      upstream,
    });
    assert.lengthOf(errors, 1);
    assert.include(errors[0], "51 ProjectionThreadLatestMessageAt");
    assert.include(errors[0], "upstream has 51 ProjectionThreadMessageContext");
  });

  it("rejects an entry beyond upstream's manifest", () => {
    const errors = checkUpstreamMigrationManifest({
      fork: fork([...upstreamEntries, [53, "ForkOnly"]]),
      upstream,
    });
    assert.lengthOf(errors, 1);
    assert.include(errors[0], "53 ForkOnly is not in upstream's manifest");
    assert.include(errors[0], "ForkMigrations");
  });

  it("rejects a later upstream migration imported without the ones before it", () => {
    const errors = checkUpstreamMigrationManifest({
      fork: fork([
        [50, "ProjectionThreadPullRequests"],
        [52, "ProjectionThreadTitleState"],
      ]),
      upstream,
    });
    assert.lengthOf(errors, 1);
    assert.include(errors[0], "position 2 is 52 ProjectionThreadTitleState");
  });

  it("describes the entries a candidate adds or changes", () => {
    assert.deepEqual(
      changedUpstreamMigrations({
        base: fork([
          [50, "ProjectionThreadPullRequests"],
          [51, "ProjectionThreadLatestMessageAt"],
        ]),
        head: fork(upstreamEntries),
      }),
      [
        "changes 51 ProjectionThreadLatestMessageAt to 51 ProjectionThreadMessageContext",
        "adds 52 ProjectionThreadTitleState",
      ],
    );
  });
});

describe("upstream migration files", () => {
  const upstreamBlobsByPath = new Map([
    ["apps/server/src/persistence/Migrations/050_A.ts", new Set(["old", "new"])],
  ]);

  it("accepts any version upstream has had at that path", () => {
    assert.deepEqual(
      checkUpstreamMigrationFiles({
        forkBlobByPath: new Map([["apps/server/src/persistence/Migrations/050_A.ts", "old"]]),
        upstreamBlobsByPath,
      }),
      [],
    );
  });

  it("rejects edited and fork-only files", () => {
    assert.deepEqual(
      checkUpstreamMigrationFiles({
        forkBlobByPath: new Map([
          ["apps/server/src/persistence/Migrations/050_A.ts", "edited"],
          ["apps/server/src/persistence/Migrations/051_Fork.ts", "fork"],
        ]),
        upstreamBlobsByPath,
      }),
      [
        "apps/server/src/persistence/Migrations/050_A.ts does not match any version of that file in upstream.",
        "apps/server/src/persistence/Migrations/051_Fork.ts does not exist in upstream.",
      ],
    );
  });

  it("checks the manifest and files at a revision", () => {
    const git: UpstreamMigrationGit = {
      show: (revision) =>
        revision === "fork"
          ? manifestSource([
              [50, "ProjectionThreadPullRequests"],
              [51, "ForkOnly"],
            ])
          : manifestSource(upstreamEntries),
      blobs: () =>
        new Map([["apps/server/src/persistence/Migrations/051_ForkOnly.ts", "fork-blob"]]),
      historyBlobs: () => new Map(),
    };
    const errors = checkUpstreamMigrationsAtRevision({
      git,
      revision: "fork",
      upstreamRevision: "upstream",
    });
    assert.lengthOf(errors, 2);
    assert.include(errors[0], "position 2 is 51 ForkOnly");
    assert.include(errors[1], "051_ForkOnly.ts does not exist in upstream");
  });
});
