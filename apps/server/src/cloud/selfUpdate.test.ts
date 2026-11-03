import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { HostActivity } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

interface HarnessOptions {
  readonly mode?: "web" | "desktop";
  readonly managed?: boolean;
  readonly preflight?: "ready" | "blocked";
  readonly preflightDuration?: Duration.Input;
  readonly preflightStarted?: Deferred.Deferred<void>;
  readonly beforeDownload?: Effect.Effect<void>;
  readonly requestUpdate?: ServiceLauncherClient.ServiceLauncherClient["Service"]["requestUpdate"];
  readonly desktopAppUpdate?: DesktopAppUpdate.DesktopAppUpdate["Service"];
  readonly activity?: Effect.Effect<HostActivity>;
  readonly policy?: ManagedPolicyDocument;
}

const idleActivity: HostActivity = {
  activeSessions: 0,
  continuableSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
  environmentsUsingDevices: 0,
};

const makeHarness = Effect.fn("test.make_self_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-test-" });
  const order: string[] = [];
  const urls: string[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (input.command === "tar") {
          order.push("install");
          const prefix = input.args[input.args.indexOf("-C") + 1];
          if (prefix === undefined) return yield* Effect.die("missing extraction directory");
          const entry = path.join(prefix, "styal");
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true }).pipe(Effect.orDie);
          yield* fs.writeFileString(entry, "export {};\n").pipe(Effect.orDie);
          return {
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }
        if (options.preflightStarted) yield* Deferred.succeed(options.preflightStarted, undefined);
        if (options.preflightDuration !== undefined) {
          // Like the real runner, fail once the caller's timeout elapses.
          const timeout = Duration.fromInputUnsafe(input.timeout ?? "60 seconds");
          const finished = yield* Effect.sleep(options.preflightDuration).pipe(
            Effect.timeoutOption(timeout),
          );
          if (finished._tag === "None") {
            return yield* new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: Duration.toMillis(timeout),
            });
          }
        }
        order.push("preflight");
        const result =
          options.preflight === "blocked"
            ? { status: "blocked", version: "1.1.0", reason: "local update required" }
            : {
                status: "ready",
                version: "1.1.0",
                launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
              };
        return {
          stdout: JSON.stringify(result),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const launcher = ServiceLauncherClient.ServiceLauncherClient.of({
    managed: options.managed ?? true,
    requestUpdate:
      options.requestUpdate ??
      (() =>
        Effect.sync(() => {
          order.push("accept");
          return "launcher-id";
        })),
    prepareTrial: Effect.undefined,
  });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const bytes = new TextEncoder().encode("archive fixture");
  const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
  const checksum = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      urls.push(request.url);
      if (new URL(request.url).pathname.endsWith("/SHA256SUMS")) {
        return HttpClientResponse.fromWeb(
          request,
          new Response(`${checksum}  styal-1.1.0-linux-x64.tar.gz\n`),
        );
      }
      if (options.beforeDownload) yield* options.beforeDownload;
      return HttpClientResponse.fromWeb(request, new Response(bytes));
    }),
  );
  const selfUpdate = yield* ServerSelfUpdate.make(
    options.activity ?? Effect.succeed(idleActivity),
  ).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, launcher),
    Effect.provideService(
      DesktopAppUpdate.DesktopAppUpdate,
      options.desktopAppUpdate ?? {
        available: false,
        inspectActivity: Effect.succeed([null]),
        run: () => Effect.die("unexpected desktop app update run"),
        commit: () => Effect.never,
      },
    ),
    Effect.provideService(HostProcess.ExecutablePath, "/usr/bin/node"),
    Effect.provide(
      Layer.merge(
        ServerConfig.layer({ ...config, mode: options.mode ?? "web" }),
        ManagedPolicy.layerTest(options.policy),
      ),
    ),
  );
  return { selfUpdate, order, urls };
});

it.layer(NodeServices.layer)("server self update", (it) => {
  it.effect(
    "refuses new terminal and waiting work after download without consent, then reuses the runtime on a consented retry",
    () =>
      Effect.gen(function* () {
        let activity = idleActivity;
        let inspections = 0;
        const { selfUpdate, order } = yield* makeHarness({
          beforeDownload: Effect.sync(() => {
            activity = { ...idleActivity, waitingSessions: 1, terminalsRequiringConfirmation: 1 };
          }),
          activity: Effect.sync(() => {
            inspections += 1;
            return activity;
          }),
        });
        const refused = yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip);
        expect(refused.reason).toContain("Activity changed");
        expect(refused.reason).toContain("Try updating again");
        expect(order).toEqual(["install", "preflight"]);
        expect(inspections).toBe(1);
        expect(
          (yield* selfUpdate.update({ targetVersion: "1.1.0", confirmed: true })).updateId,
        ).toBe("launcher-id");
        expect(order).toEqual(["install", "preflight", "preflight", "accept"]);
        expect(inspections).toBe(1);
      }),
  );

  it.effect.each([
    { name: "idle", activity: idleActivity, continues: false, safe: true },
    {
      name: "resumable",
      activity: { ...idleActivity, activeSessions: 1, continuableSessions: 1 },
      continues: true,
      safe: true,
    },
    {
      name: "continuation disabled",
      activity: { ...idleActivity, activeSessions: 1, continuableSessions: 1 },
      continues: false,
      safe: false,
    },
  ])(
    "checks $name activity before activating a boot-service update",
    ({ activity, continues, safe }) =>
      Effect.gen(function* () {
        const { selfUpdate, order } = yield* makeHarness({ activity: Effect.succeed(activity) });
        const result = yield* selfUpdate
          .update({ targetVersion: "1.1.0", continueRunningThreads: continues, confirmed: false })
          .pipe(Effect.result);
        expect(result._tag).toBe(safe ? "Success" : "Failure");
        expect(order.includes("accept")).toBe(safe);
      }),
  );

  it.effect("fails closed when final boot-service activity inspection fails", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness({
        activity: Effect.die("activity unavailable"),
      });
      const reason = (yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip))
        .reason;
      expect(reason).toContain("Could not check the server for running work");
      expect(reason).not.toContain("Activity changed");
      expect(order).not.toContain("accept");
    }),
  );

  it.effect("waits for a slow final activity read longer than the client's check", () =>
    Effect.gen(function* () {
      const inspecting = yield* Deferred.make<void>();
      const { selfUpdate, order } = yield* makeHarness({
        activity: Deferred.succeed(inspecting, undefined).pipe(
          Effect.andThen(Effect.sleep("6 seconds")),
          Effect.as(idleActivity),
        ),
      });
      const fiber = yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.forkChild);
      yield* Deferred.await(inspecting);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("6 seconds");
      expect((yield* Fiber.join(fiber)).updateId).toBe("launcher-id");
      expect(order).toContain("accept");
    }),
  );

  it.effect("fails closed when the final activity read never finishes", () =>
    Effect.gen(function* () {
      const inspecting = yield* Deferred.make<void>();
      const { selfUpdate, order } = yield* makeHarness({
        activity: Deferred.succeed(inspecting, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const fiber = yield* selfUpdate
        .update({ targetVersion: "1.1.0" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(inspecting);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 minute");
      expect((yield* Fiber.join(fiber)).reason).toContain(
        "Could not check the server for running work",
      );
      expect(order).not.toContain("accept");
    }),
  );

  it.effect("stages and preflights before asking the launcher for an update ID", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness();
      expect(yield* selfUpdate.update({ targetVersion: "1.1.0" })).toEqual({
        targetVersion: "1.1.0",
        method: "boot-service",
        updateId: "launcher-id",
      });
      expect(order).toEqual(["install", "preflight", "accept"]);
    }),
  );

  // regression: #5181 make remote updates rollback-safe
  it.effect("rejects invalid versions and desktop-managed servers before staging", () =>
    Effect.gen(function* () {
      const web = yield* makeHarness();
      expect(
        (yield* web.selfUpdate.update({ targetVersion: "latest" }).pipe(Effect.flip)).reason,
      ).toBe("'latest' is not an exact styal version.");
      const desktop = yield* makeHarness({ mode: "desktop" });
      expect(
        (yield* desktop.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
      ).toContain("desktop app");
      expect([...web.order, ...desktop.order]).toEqual([]);
    }),
  );

  it.effect("refuses every update when the managed policy turns updates off", () =>
    Effect.gen(function* () {
      const policy: ManagedPolicyDocument = {
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { updates: { mode: "off" } },
      };
      const service = yield* makeHarness({ policy });
      const desktop = yield* makeHarness({
        mode: "desktop",
        policy,
        desktopAppUpdate: {
          available: true,
          inspectActivity: Effect.succeed([null]),
          run: () => Effect.die("unexpected desktop app update run"),
          commit: () => Effect.never,
        },
      });
      for (const harness of [service, desktop]) {
        expect(
          (yield* harness.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
        ).toBe("Example Corp manages styal updates.");
      }
      expect([...service.order, ...desktop.order]).toEqual([]);
    }),
  );

  it.effect("lets a user start an update, but only to stable without nightly", () =>
    Effect.gen(function* () {
      const { selfUpdate, order, urls } = yield* makeHarness({
        policy: {
          schemaVersion: 1,
          organization: "Example Corp",
          limits: {
            updates: {
              mode: "auto",
              allowNightly: false,
              feedUrl: "https://updates.example.com/t3code/?token=abc",
            },
          },
        },
      });
      expect(
        (yield* selfUpdate.update({ targetVersion: "1.2.0-nightly.20261028.1" }).pipe(Effect.flip))
          .reason,
      ).toBe("Example Corp manages styal updates. Only stable releases can be installed.");
      expect(order).toEqual([]);
      expect(urls).toEqual([]);
      // The mirror lists only 1.1.0's archive.
      expect((yield* selfUpdate.update({ targetVersion: "1.2.0" }).pipe(Effect.flip)).reason).toBe(
        "Example Corp's update mirror has no @styal/cli@1.2.0 for this machine.",
      );
      expect(
        (yield* selfUpdate.update({ targetVersion: "1.1.0", channel: "latest" })).updateId,
      ).toBe("launcher-id");
      // The release comes from the policy's mirror, not GitHub.
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls)
        expect(url).toMatch(/^https:\/\/updates\.example\.com\/t3code\/v1\.[12]\.0\//);
      expect(urls.every((url) => new URL(url).search === "?token=abc")).toBe(true);
    }),
  );

  it.effect.each([undefined, false, true] as const)(
    "delegates desktop-managed updates with explicit consent (%s)",
    (confirmed) =>
      Effect.gen(function* () {
        const stages: string[] = [];
        const confirmations: boolean[] = [];
        const { selfUpdate, order } = yield* makeHarness({
          mode: "desktop",
          desktopAppUpdate: {
            available: true,
            inspectActivity: Effect.succeed([null]),
            run: (reportProgress, consent = false) =>
              Effect.sync(() => {
                confirmations.push(consent);
              }).pipe(
                Effect.andThen(reportProgress("downloading")),
                Effect.andThen(reportProgress("installing")),
                Effect.as({ targetVersion: "1.2.0", method: "desktop-app" as const }),
              ),
            commit: () => Effect.never,
          },
        });
        const result = yield* selfUpdate.update(
          { targetVersion: "1.1.0", ...(confirmed === undefined ? {} : { confirmed }) },
          (stage) => Effect.sync(() => void stages.push(stage)),
        );
        expect(result).toEqual({ targetVersion: "1.2.0", method: "desktop-app" });
        expect(stages).toEqual(["downloading", "installing"]);
        expect(confirmations).toEqual([confirmed === true]);
        expect(order).toEqual([]);
      }),
  );

  it.effect("allows only one update at a time", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<string>();
      const { selfUpdate } = yield* makeHarness({
        requestUpdate: () =>
          Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
      });
      const first = yield* Effect.forkChild(selfUpdate.update({ targetVersion: "1.1.0" }), {
        startImmediately: true,
      });
      yield* Deferred.await(requested);
      expect((yield* selfUpdate.update({ targetVersion: "1.1.1" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
      yield* Deferred.succeed(accepted, "launcher-id");
      expect((yield* Fiber.join(first)).updateId).toBe("launcher-id");
    }),
  );

  // regression: #28198 a slow staged preflight on a loaded host no longer fails the update
  it.effect("waits for a staged preflight that takes a minute on a loaded host", () =>
    Effect.gen(function* () {
      const preflightStarted = yield* Deferred.make<void>();
      const { selfUpdate, order } = yield* makeHarness({
        preflightDuration: "60 seconds",
        preflightStarted,
      });
      const update = yield* Effect.forkChild(selfUpdate.update({ targetVersion: "1.1.0" }), {
        startImmediately: true,
      });
      yield* Deferred.await(preflightStarted);
      yield* TestClock.adjust("60 seconds");
      const exit = yield* Fiber.await(update);
      expect(exit._tag === "Failure" ? String(exit.cause) : "launcher handoff").toBe(
        "launcher handoff",
      );
      expect(order).toEqual(["install", "preflight", "accept"]);
    }),
  );

  it.effect("keeps preparing after the progress stream closes", () =>
    Effect.gen(function* () {
      const releaseDownload = yield* Deferred.make<void>();
      const sawDownloading = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<void>();
      const { selfUpdate, order } = yield* makeHarness({
        beforeDownload: Deferred.await(releaseDownload),
        requestUpdate: () =>
          Effect.sync(() => {
            order.push("accept");
          }).pipe(Effect.andThen(Deferred.succeed(accepted, undefined)), Effect.as("launcher-id")),
      });

      const consumed = yield* ServerSelfUpdate.updateProgressStream(selfUpdate, {
        targetVersion: "1.1.0",
      }).pipe(
        Stream.tap((event) =>
          event.type === "progress" && event.stage === "downloading"
            ? Deferred.succeed(sawDownloading, undefined)
            : Effect.void,
        ),
        Stream.runDrain,
        Effect.forkChild,
      );

      yield* Deferred.await(sawDownloading);
      yield* Fiber.interrupt(consumed);
      expect((yield* selfUpdate.update({ targetVersion: "1.2.0" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );

      yield* Deferred.succeed(releaseDownload, undefined);
      yield* Deferred.await(accepted);
      expect(order).toEqual(["install", "preflight", "accept"]);
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
    }),
  );
});

it.layer(NodeServices.layer)("pruning runtimes on start", (it) => {
  const staleVersion = "0.0.1";
  const otherProcesses = ProcessRunner.ProcessRunner.of({
    run: () =>
      Effect.succeed({
        stdout: "p42\nftxt\nn/bin/sh\n",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });

  const pruneOnStart = Effect.fn("test.prune_on_start")(function* (input: {
    readonly executable: "own runtime" | "elsewhere";
    readonly managed?: boolean;
    readonly symlinkedHome?: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-prune-on-start-" });
    const realHome = path.join(tempDir, "home");
    const baseDir = input.symlinkedHome ? path.join(tempDir, "linked-home") : realHome;
    const versionsDir = path.join(baseDir, "runtime", "styal-executable", "versions");
    yield* TestClock.setTime(24 * 60 * 60 * 1000);
    for (const version of [staleVersion, packageJson.version]) {
      const directory = path.join(realHome, "runtime", "styal-executable", "versions", version);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "styal"), "");
      const sentinel = path.join(directory, ".install-complete");
      yield* fs.writeFileString(sentinel, `${version}\n`);
      yield* fs.utimes(sentinel, 0, 0);
    }
    if (input.symlinkedHome) yield* fs.symlink(realHome, baseDir);
    // Like `process.execPath`, the running runtime is reported by its real path.
    const executablePath =
      input.executable === "own runtime"
        ? yield* fs.realPath(path.join(versionsDir, packageJson.version, "styal"))
        : "/usr/local/bin/node";
    const removed = yield* ServerSelfUpdate.pruneRuntimesOnStart({
      baseDir,
      managed: input.managed ?? false,
    }).pipe(
      Effect.provideService(HostProcess.ExecutablePath, executablePath),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(ProcessRunner.ProcessRunner, otherProcesses),
    );
    return { removed, remaining: (yield* fs.readDirectory(versionsDir)).toSorted() };
  });

  // The SSH launcher runs `t3 serve` straight from the pinned runtime, with no boot service.
  it.effect("prunes for a server started from its home's pinned runtime", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({ executable: "own runtime" });
      expect(removed).toEqual([staleVersion]);
      expect(remaining).toEqual([packageJson.version]);
    }),
  );

  it.effect("recognizes its runtime through a symlinked T3 home", () =>
    Effect.gen(function* () {
      const { removed } = yield* pruneOnStart({ executable: "own runtime", symlinkedHome: true });
      expect(removed).toEqual([staleVersion]);
    }),
  );

  it.effect("prunes for a boot-service server wherever it runs from", () =>
    Effect.gen(function* () {
      const { removed } = yield* pruneOnStart({ executable: "elsewhere", managed: true });
      expect(removed).toEqual([staleVersion]);
    }),
  );

  it.effect("leaves runtimes alone for an unmanaged server started elsewhere", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({ executable: "elsewhere" });
      expect(removed).toEqual([]);
      expect(remaining).toEqual([staleVersion, packageJson.version].toSorted());
    }),
  );
});

it("a host crosses tracks only to a release that knows its whole database", () => {
  const cross = (
    serverVersion: string,
    targetVersion: string,
    targetDatabaseMigration: number | undefined,
    databaseMigration = 72,
  ) =>
    ServerSelfUpdate.trackSwitchBlockReason({
      serverVersion,
      targetVersion,
      targetDatabaseMigration,
      databaseMigration: () => databaseMigration,
    });
  const nightly = "0.1.4-nightly.20261027.3796";

  expect(cross(nightly, "0.1.4", 72)).toBeNull();
  // Another client moved this host to a newer Nightly after the switch was planned.
  expect(cross(nightly, "0.1.4", 72, 73)).toContain("does not support yet");
  expect(cross(nightly, "0.1.4", undefined)).toContain("Cannot confirm");
  // A Stable tag can carry a migration the latest Nightly lacks.
  expect(cross("0.1.4", nightly, 72, 73)).toContain("does not support yet");
  expect(cross("0.1.3", "0.1.4", undefined)).toBeNull();
  // A database that exists but cannot be read proves nothing.
  expect(
    ServerSelfUpdate.trackSwitchBlockReason({
      serverVersion: nightly,
      targetVersion: "0.1.4",
      targetDatabaseMigration: 72,
      databaseMigration: () => undefined,
    }),
  ).toContain("Cannot confirm");
});
