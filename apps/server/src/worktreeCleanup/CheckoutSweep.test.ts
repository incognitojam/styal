import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as PhysicalFileSystem from "@t3tools/shared/PhysicalFileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  ProjectId,
  RunId,
  RuntimeRequestId,
  type OrchestrationProjectShell,
  type TerminalSummary,
  type StorageCleanupReportEntry,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { fixture, nodeLayer, shell } from "./fixtures.testkit.ts";
import * as Settings from "../serverSettings.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ServerConfig from "../config.ts";
import { CheckoutRetention, CheckoutSweepLimits, makeCheckoutSweep } from "./CheckoutSweep.ts";
import { CheckoutLimits, makeCheckout } from "./Checkout.ts";

import { makeHasCanonicalTerminal } from "../storageCleanup.ts";
import { makeWorkspaceLease } from "../workspace/workspaceLease.ts";
import { TestClock } from "effect/testing";
import { ThreadId } from "@t3tools/contracts";

const setup = Effect.gen(function* () {
  const f = yield* fixture;
  const sql = yield* SqlClient.SqlClient;
  const hasCanonicalTerminal = yield* makeHasCanonicalTerminal;
  yield* sql`CREATE TABLE orchestration_v2_projection_provider_sessions (payload_json TEXT, status TEXT)`;
  yield* f.fs.writeFileString(
    `${f.root}/styal.json`,
    '{"regenerableFiles":["dist","node_modules"]}',
  );
  yield* f.command(f.root, ["add", "styal.json"]);
  yield* f.command(f.root, ["commit", "-m", "fixture: declare cleanup"]);
  const project: OrchestrationProjectShell = {
    id: ProjectId.make("project-1"),
    title: "Synthetic",
    workspaceRoot: f.root,
    repositoryIdentity: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    additionalInstructions: null,
    projectIcon: null,
    scripts: [],
    pinnedAt: null,
    pinOrderKey: null,
    archivedAt: null,
    createdAt: "1970-01-01T00:00:00Z",
    updatedAt: "1970-01-01T00:00:00Z",
  };
  let threads = [
    shell({
      worktreePath: f.worktree,
      branch: "quiet",
      settledOverride: "settled",
      settledAt: DateTime.makeUnsafe(0),
    }),
  ];
  let afterRead = Effect.void;
  let projectList = [project];
  let terminal = false;
  let live = false;
  let terminalPaths: Array<Pick<TerminalSummary, "status" | "cwd" | "worktreePath">> = [];
  yield* TestClock.adjust("8 days");
  const layers = Layer.mergeAll(
    Layer.succeed(ServerConfig.ServerConfig, f.config),
    Layer.succeed(GitVcsDriver.GitVcsDriver, f.git),
    Settings.layerTest({
      regenerableFileCleanupMigrated: true,
      projectSettingsOverrides: { [project.id]: { releaseWorktreeSources: true } },
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.sync(() => projectList) }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () =>
        Effect.sync(() => ({
          schemaVersion: 1,
          snapshotSequence: 0,
          projects: [],
          threads,
          archivedThreads: [],
        })).pipe(Effect.tap(() => afterRead)),
      getThreadShell: (id) =>
        Effect.sync(() => threads.find((thread) => thread.id === id) ?? null).pipe(
          Effect.tap(() => afterRead),
        ),
    }),
    Layer.mock(ProviderSessions.ProviderSessionManagerV2)({
      isLive: () => Effect.sync(() => live),
    }),
  );
  return {
    ...f,
    project,
    layers,
    sql,
    setProjects: (next: OrchestrationProjectShell[]) => {
      projectList = next;
    },
    setAfterRead: (effect: Effect.Effect<void>) => {
      afterRead = effect;
    },
    setThreads: (next: OrchestrationV2ThreadShell[]) => {
      threads = next;
    },
    threads: () => threads,
    terminal: () => terminal,
    setTerminal: (value: boolean) => {
      terminal = value;
    },
    canonicalTerminal: (root: string) => hasCanonicalTerminal(root, terminalPaths),
    setTerminalPaths: (paths: typeof terminalPaths) => {
      terminalPaths = paths;
    },
    setLive: (value: boolean) => {
      live = value;
    },
  };
});

const testLayers = Layer.mergeAll(nodeLayer, NodeSqliteClient.layer({ filename: ":memory:" }));

it.effect.each([
  "none",
  "active",
  "run",
  "request",
  "queued",
  "background",
  "terminal",
  "session",
  "no-thread",
  "root",
  "young",
  "short-retention",
  "parent",
  "unsettle",
  "unsettle-during-inspection",
  "aliased-thread",
  "setting-off",
  "windows",
  "unmanaged",
  "archived",
  "parent-active",
  "project-root-inside",
  "missing-project",
  "missing-worktree",
  "terminal-alias",
  "terminal-alias-final",
  "terminal-unverifiable",
  "deadline",
] as const)("source sweep rechecks ownership and activity under the lease: %s", (blocker) =>
  Effect.gen(function* () {
    const f = yield* setup;
    const platform = yield* HostProcess.Platform;
    yield* f.write("src/clean", "source");
    yield* f.command(f.worktree, ["add", "."]);
    yield* f.command(f.worktree, ["commit", "-m", "fixture: source"]);
    const original = f.threads()[0]!;
    if (blocker === "aliased-thread") {
      const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
      const alias = `${f.base}/worktree-alias`;
      yield* Effect.promise(() => physical.symlink(f.worktree, alias));
      f.setThreads([
        original,
        {
          ...original,
          id: ThreadId.make("active-alias"),
          worktreePath: alias,
          settledAt: null,
          settledOverride: "active",
        },
      ]);
    }
    if (blocker === "missing-project")
      f.setProjects([
        f.project,
        { ...f.project, id: ProjectId.make("missing"), workspaceRoot: `${f.base}/missing-project` },
      ]);
    if (blocker === "missing-worktree")
      yield* f.command(f.root, ["worktree", "remove", f.worktree]);
    if (blocker === "terminal-alias" || blocker === "terminal-alias-final") {
      const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
      const alias = `${f.base}/terminal-alias`;
      yield* Effect.promise(() => physical.symlink(f.worktree, alias));
      if (blocker === "terminal-alias")
        f.setTerminalPaths([{ cwd: alias, worktreePath: null, status: "running" }]);
    }
    if (blocker === "terminal-unverifiable")
      f.setTerminalPaths([
        { cwd: `${f.base}/missing-terminal-alias`, worktreePath: null, status: "running" },
      ]);
    if (blocker === "active")
      f.setThreads([{ ...original, settledAt: null, settledOverride: "active" }]);
    if (blocker === "run")
      f.setThreads([{ ...original, activeRunId: RunId.make("run-1"), status: "running" }]);
    if (blocker === "request")
      f.setThreads([
        {
          ...original,
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request"),
            kind: "command",
            createdAt: DateTime.makeUnsafe(0),
          },
        },
      ]);
    if (blocker === "background")
      f.setThreads([
        { ...original, pendingBackgroundTasks: [{ taskId: "background", kind: "subagent" }] },
      ]);
    if (blocker === "queued") f.setThreads([{ ...original, status: "queued" }]);
    if (blocker === "terminal") f.setTerminal(true);
    if (blocker === "no-thread") f.setThreads([]);
    if (blocker === "root") f.setThreads([{ ...original, worktreePath: f.root }]);
    if (blocker === "unmanaged") {
      const destination = `${f.base}/unmanaged`;
      yield* f.fs.rename(f.worktree, destination);
      f.setThreads([{ ...original, worktreePath: destination }]);
    }
    if (blocker === "project-root-inside")
      f.setProjects([
        f.project,
        { ...f.project, id: ProjectId.make("nested"), workspaceRoot: f.worktree },
      ]);
    if (blocker === "archived")
      f.setThreads([
        {
          ...original,
          settledAt: null,
          settledOverride: null,
          archivedAt: DateTime.makeUnsafe(0),
        },
      ]);
    if (blocker === "parent-active")
      f.setThreads([
        {
          ...original,
          id: ThreadId.make("child"),
          settledAt: null,
          settledOverride: null,
          lineage: {
            rootThreadId: original.id,
            parentThreadId: original.id,
            relationshipToParent: "subagent",
          },
        },
        { ...original, worktreePath: null, settledAt: null, settledOverride: "active" },
      ]);
    if (blocker === "young" || blocker === "short-retention")
      f.setThreads([{ ...original, settledAt: DateTime.makeUnsafe(8 * 86_400_000 - 100) }]);
    if (blocker === "parent")
      f.setThreads([
        {
          ...original,
          id: ThreadId.make("child"),
          settledAt: null,
          settledOverride: null,
          lineage: {
            rootThreadId: original.id,
            parentThreadId: original.id,
            relationshipToParent: "subagent",
          },
        },
        { ...original, worktreePath: null },
      ]);
    if (blocker === "session") {
      // Use the same persisted live-session fixture as the regenerable-file sweep.
      yield* f.sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES (${'{"id":"session","cwd":"' + f.worktree + '"}'}, 'ready')`;
      f.setLive(true);
    }
    yield* Effect.gen(function* () {
      if (blocker === "setting-off") {
        const settings = yield* Settings.ServerSettingsService;
        yield* settings.updateSettings({
          projectSettingsOverrides: { [f.project.id]: { releaseWorktreeSources: false } },
        });
      }
      const retention = yield* CheckoutRetention;
      const sweep = yield* makeCheckoutSweep.pipe(
        Effect.provideService(CheckoutSweepLimits, {
          durationMs: blocker === "deadline" ? 50 : 600_000,
          roots: 10_000,
        }),
        Effect.provideService(CheckoutRetention, blocker === "short-retention" ? 50 : retention),
        Effect.provideService(CheckoutLimits, {
          entries: 100_000,
          bytes: 1_000_000,
          step: (step) =>
            Effect.gen(function* () {
              if (blocker === "deadline" && step === "release-recorded")
                yield* TestClock.adjust("100 millis");
              if (blocker === "terminal-alias-final" && step === "release-recorded")
                f.setTerminalPaths([
                  { cwd: `${f.base}/terminal-alias`, worktreePath: null, status: "running" },
                ]);
              if (blocker === "unsettle-during-inspection" && step === "release-recorded")
                f.setThreads([{ ...original, settledAt: null, settledOverride: "active" }]);
            }),
        }),
        Effect.provideService(HostProcess.Platform, blocker === "windows" ? "win32" : platform),
      );
      const reports: StorageCleanupReportEntry[] = [];
      if (blocker === "unsettle") {
        const held = yield* Deferred.make<void>();
        const unblock = yield* Deferred.make<void>();
        const lease = yield* makeWorkspaceLease;
        const holder = yield* lease(
          f.worktree,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(unblock))),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(held);
        const checked = yield* Deferred.make<void>();
        f.setAfterRead(Deferred.succeed(checked, undefined).pipe(Effect.asVoid));
        const waiting = yield* sweep(f.terminal, reports, f.canonicalTerminal).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(checked);
        f.setThreads([{ ...original, settledAt: null, settledOverride: "active" }]);
        yield* Deferred.succeed(unblock, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(waiting);
      } else yield* sweep(f.terminal, reports, f.canonicalTerminal);
      const expectedPath =
        blocker === "unmanaged" ? `${f.base}/unmanaged/src/clean` : `${f.worktree}/src/clean`;
      expect(yield* f.fs.exists(expectedPath)).toBe(
        blocker !== "none" &&
          blocker !== "parent" &&
          blocker !== "archived" &&
          blocker !== "short-retention" &&
          blocker !== "missing-project" &&
          blocker !== "missing-worktree",
      );
      if (
        blocker === "none" ||
        blocker === "parent" ||
        blocker === "archived" ||
        blocker === "short-retention" ||
        blocker === "missing-project"
      )
        expect(reports.some((entry) => entry.outcome === "removed")).toBe(true);
      if (blocker === "missing-worktree") expect(reports).toEqual([]);
    }).pipe(Effect.provide(f.layers));
  }).pipe(Effect.provide(testLayers)),
);

it.effect("keeps remaining worktrees after the sweep reaches its worktree limit", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.write("src/clean", "source");
    yield* f.command(f.worktree, ["add", "."]);
    yield* f.command(f.worktree, ["commit", "-m", "fixture: source"]);
    const second = `${f.config.worktreesDir}/fixture/second`;
    const commit = (yield* f.command(f.worktree, ["rev-parse", "HEAD"])).stdout.trim();
    yield* f.command(f.root, ["worktree", "add", "--detach", second, commit]);
    const original = f.threads()[0]!;
    f.setThreads([original, { ...original, id: ThreadId.make("second"), worktreePath: second }]);
    yield* Effect.gen(function* () {
      const sweep = yield* makeCheckoutSweep.pipe(
        Effect.provideService(CheckoutSweepLimits, { durationMs: 600_000, roots: 1 }),
      );
      const report: StorageCleanupReportEntry[] = [];
      yield* sweep(f.terminal, report, f.canonicalTerminal);
      expect(yield* f.fs.exists(`${f.worktree}/src/clean`)).toBe(false);
      expect(yield* f.fs.readFileString(`${second}/src/clean`)).toBe("source");
      expect(report.some((entry) => entry.reason.includes("limit"))).toBe(true);
    }).pipe(Effect.provide(f.layers));
  }).pipe(Effect.provide(testLayers)),
);

it.effect(
  "reports a released worktree after its owner becomes active without using the folder",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.write("src/clean", "source");
      yield* f.command(f.worktree, ["add", "."]);
      yield* f.command(f.worktree, ["commit", "-m", "fixture: source"]);
      yield* Effect.gen(function* () {
        const checkout = yield* makeCheckout;
        const estimatedBytes = yield* checkout.release(f.worktree, f.root);
        f.setThreads([{ ...f.threads()[0]!, settledAt: null, settledOverride: "active" }]);
        const sweep = yield* makeCheckoutSweep;
        const report: StorageCleanupReportEntry[] = [];
        yield* sweep(f.terminal, report, f.canonicalTerminal);
        expect(yield* f.fs.exists(`${f.worktree}/src/clean`)).toBe(false);
        expect(report).toEqual([
          expect.objectContaining({
            path: f.worktree,
            reason: "Sources remain un-checked-out; restored before use",
            bytes: estimatedBytes,
          }),
        ]);
      }).pipe(Effect.provide(f.layers));
    }).pipe(Effect.provide(testLayers)),
);
