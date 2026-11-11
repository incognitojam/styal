import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodePath from "@effect/platform-node/NodePath";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { decideProviderAutoUpdate, make } from "./ProviderAutoUpdater.ts";
import type { ProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenance";
import { ProviderInstallGate, type ProviderInstallTarget } from "./ProviderInstallGate.ts";
import { ProviderMaintenanceRunner } from "./providerMaintenanceRunner.ts";
import * as Journal from "./ProviderUpdateJournal.ts";
import * as Gate from "./ProviderInstallGate.ts";
import * as InstallLock from "./ProviderInstallLock.ts";
import * as InstanceRegistry from "./ProviderInstanceRegistry.ts";
import { ProviderUpdateJournal } from "./ProviderUpdateJournal.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";

const codex: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.0.0",
    latestVersion: "3.0.0",
    updateCommand: "npm install -g @openai/codex@latest",
    canUpdate: true,
    canInstallVersion: true,
    checkedAt: "2026-10-01T00:00:00.000Z",
    message: null,
  },
};

const withAdvisory = (
  advisory: Partial<NonNullable<ServerProvider["versionAdvisory"]>>,
): ServerProvider => ({ ...codex, versionAdvisory: { ...codex.versionAdvisory!, ...advisory } });

const manifestWith = (
  autoUpdates: ReadonlyArray<{ version: string; package: string; styal: string }>,
): ModelManifest.ModelManifestData => ({
  version: 1,
  currentModels: {},
  compatibility: [
    {
      driver: "codex",
      t3CodeRange: ">=0.0.0",
      autoUpdates,
      ranges: [{ range: ">=1.0.0", status: "supported" }],
    },
  ],
});

const verified = manifestWith([{ version: "2.0.0", package: "@openai/codex", styal: "0.0.1" }]);

describe("decideProviderAutoUpdate", () => {
  it("installs the verified version when the installer can pin it", () => {
    const upgrade = { version: "2.0.0", takeover: false };
    assert.deepStrictEqual(decideProviderAutoUpdate(codex, "2.0.0"), upgrade);
    // Behind is an upgrade whether or not the provider's own updater is on.
    assert.deepStrictEqual(decideProviderAutoUpdate(codex, "2.0.0", true), upgrade);
  });

  it("takes over an install on the verified version while its own updater is active", () => {
    const current = { ...codex, version: "2.0.0" };
    assert.deepStrictEqual(decideProviderAutoUpdate(current, "2.0.0", true), {
      version: "2.0.0",
      takeover: true,
    });
    // Updater off, unknown, or not detectable for this installer.
    for (const active of [false, null, undefined]) {
      assert.strictEqual(decideProviderAutoUpdate(current, "2.0.0", active), null);
    }
    // Never moved back, even to take over.
    assert.strictEqual(
      decideProviderAutoUpdate({ ...codex, version: "2.1.0" }, "2.0.0", true),
      null,
    );
    // Only an installer that can pin the version takes over.
    assert.strictEqual(
      decideProviderAutoUpdate(
        { ...current, versionAdvisory: { ...codex.versionAdvisory!, canInstallVersion: false } },
        "2.0.0",
        true,
      ),
      null,
    );
  });

  it("leaves current, newer, unknown, disabled, unpinnable and manual installs alone", () => {
    for (const provider of [
      { ...codex, version: "2.0.0" },
      { ...codex, version: "2.1.0" },
      { ...codex, version: "2.1.0-beta.1" },
      { ...codex, version: null },
      { ...codex, enabled: false },
      { ...codex, installed: false },
      { ...codex, status: "error" as const },
      withAdvisory({ canUpdate: false }),
      // Native updaters and Homebrew install whatever is newest.
      withAdvisory({ canInstallVersion: false, latestVersion: "2.0.0" }),
    ]) {
      assert.strictEqual(decideProviderAutoUpdate(provider, "2.0.0"), null);
    }
    assert.strictEqual(decideProviderAutoUpdate(codex, null), null);
  });
});

// `codex_work` is a second instance of the same CLI; Claude shares the npm prefix only.
const targets: Record<string, ProviderInstallTarget> = {
  codex: { lockKey: "npm-global:/usr/local", packageName: "@openai/codex" },
  codex_work: { lockKey: "npm-global:/usr/local", packageName: "@openai/codex" },
  claude: { lockKey: "npm-global:/usr/local", packageName: "@anthropic-ai/claude-code" },
};

interface FixtureThread {
  readonly id?: string;
  readonly providerInstanceId: string;
  readonly status: string;
  readonly activityRunStatus?: string | null;
  readonly pendingRuntimeRequest?: unknown;
}

/** A question the agent asked at `createdAtMs` on the test clock. */
const pendingQuestion = (createdAtMs: number) => ({
  id: "request",
  kind: "user_input",
  createdAt: DateTime.makeUnsafe(createdAtMs),
});

const HOUR_MS = 60 * 60 * 1_000;

interface Fixture {
  readonly journal?: ProviderUpdateJournal["Service"];
  readonly gate?: ProviderInstallGate["Service"];
  readonly checkFails?: boolean;
  readonly capabilityReads?: Array<unknown>;
  readonly records?: Array<unknown>;
  readonly settings?: Partial<ServerSettings>;
  /** Status of a Codex thread per shell snapshot read, in order; the last one repeats. */
  readonly threadStatuses?: ReadonlyArray<string | null>;
  /** Threads present in every shell snapshot read. */
  readonly otherThreads?: ReadonlyArray<FixtureThread>;
  /** Options of each shell snapshot read. */
  readonly snapshotReads?: Array<unknown>;
  readonly manifest?: ModelManifest.ModelManifestData;
  /** Age of the fetched manifest, or null for no fetched copy. */
  readonly manifestAgeMs?: number | null;
  /** The provider as a fresh health check inside the lock sees it. */
  readonly refreshed?: ServerProvider;
  /** The provider every pass sees. */
  readonly provider?: ServerProvider;
  /** Whether the provider's own updater is active, per cached and per fresh capability read. */
  readonly selfUpdaterActive?: boolean | null;
  readonly freshSelfUpdaterActive?: boolean | null;
  readonly installs: Array<unknown>;
  readonly onInstall?: Effect.Effect<void>;
  readonly devUrl?: string;
}

const testLayer = (input: Fixture) => {
  let snapshotReads = 0;
  const statuses = input.threadStatuses ?? [null];
  const ageMs = input.manifestAgeMs === undefined ? 60_000 : input.manifestAgeMs;
  return Layer.mergeAll(
    Layer.succeed(
      ProviderUpdateJournal,
      input.journal ?? {
        record: (instanceId, driver, entry) =>
          Effect.sync(() => {
            input.records?.push({ instanceId, driver, ...entry });
          }),
      },
    ),
    // The service has no partial config form.
    Layer.succeed(ServerConfig, { devUrl: input.devUrl } as never),
    ServerSettingsService.layerTest(input.settings ?? {}),
    Layer.mock(ProviderRegistry)({
      getProviders: Effect.succeed([input.provider ?? codex]),
      // The check inside the lock must not depend on the update advisory,
      // which a live health refresh did not carry.
      refreshInstance: () => {
        const { versionAdvisory: _advisory, ...refreshed } =
          input.refreshed ?? input.provider ?? codex;
        return Effect.succeed([refreshed]);
      },
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, _driver, options) => {
        input.capabilityReads?.push(_instanceId);
        if (input.checkFails) return Effect.die("synthetic check failure");
        const selfUpdaterActive = options?.fresh
          ? input.freshSelfUpdaterActive
          : input.selfUpdaterActive;
        return Effect.succeed({
          provider: codex.driver,
          packageName: "@openai/codex",
          update: null,
          ...(selfUpdaterActive === undefined ? {} : { selfUpdaterActive }),
        } satisfies ProviderMaintenanceCapabilities);
      },
    }),
    Layer.mock(ModelManifest.ModelManifest)({
      refresh: Effect.succeed(input.manifest ?? verified),
      remote: Clock.currentTimeMillis.pipe(
        Effect.map((now) =>
          ageMs === null
            ? null
            : { manifest: input.manifest ?? verified, fetchedAtMs: now - ageMs },
        ),
      ),
    }),
    Layer.mock(ProjectionStoreV2)({
      getShellSnapshot: (options) =>
        Effect.sync(() => {
          input.snapshotReads?.push(options);
          const status = statuses[Math.min(snapshotReads++, statuses.length - 1)];
          const threads = [
            ...(status ? [{ providerInstanceId: "codex", status }] : []),
            ...(input.otherThreads ?? []),
          ].map((thread) => ({
            id: "thread",
            activityRunStatus: null,
            pendingRuntimeRequest: null,
            ...thread,
          }));
          return { threads } as never;
        }),
    }),
    input.gate
      ? Layer.succeed(ProviderInstallGate, input.gate)
      : Layer.mock(ProviderInstallGate)({
          targetFor: (instanceId) => Effect.succeed(targets[instanceId] ?? null),
        }),
    // Mirrors the real runner: `shouldStart` decides whether the install runs.
    Layer.mock(ProviderMaintenanceRunner)({
      updateProvider: (target) =>
        Effect.gen(function* () {
          if (typeof target === "string") return yield* Effect.die("untargeted update");
          if (target.autoUpdate && !(yield* target.autoUpdate.shouldStart)) {
            return { providers: [codex] };
          }
          input.installs.push({
            instanceId: target.instanceId,
            version: target.targetVersion,
            ...(target.autoUpdate?.takeover ? { takeover: true } : {}),
          });
          yield* target.autoUpdate?.record?.({ outcome: "started" }) ?? Effect.void;
          yield* input.onInstall ?? Effect.void;
          return {
            providers: [
              {
                ...codex,
                updateState: {
                  status: "succeeded" as const,
                  startedAt: null,
                  finishedAt: null,
                  message: null,
                  output: null,
                },
              },
            ],
          };
        }).pipe((effect) =>
          input.gate
            ? input.gate
                .tryInstall(targets.codex!, () => effect)
                .pipe(Effect.map(Option.getOrThrow), Effect.orDie)
            : effect,
        ),
    }),
  );
};

const runPassWith = (input: Fixture) =>
  Effect.flatMap(make, (updater) => updater.runPass).pipe(Effect.provide(testLayer(input)));

describe("ProviderAutoUpdater.runPass", () => {
  it.effect(
    "a manual request installs the approved version without waiting for the periodic pass",
    () =>
      Effect.gen(function* () {
        const installs: Array<unknown> = [];
        const installed = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          const updater = yield* make;
          yield* updater.requestPass.pipe(Effect.scoped);
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(installed);
          assert.deepStrictEqual(installs, [{ instanceId: "codex", version: "2.0.0" }]);
        }).pipe(
          Effect.provide(
            testLayer({
              installs,
              onInstall: Deferred.await(release).pipe(
                Effect.andThen(Deferred.succeed(installed, undefined)),
              ),
            }),
          ),
        );
      }),
  );

  it.effect("overlapping manual and periodic passes do not install the same CLI twice", () =>
    Effect.gen(function* () {
      const installs: Array<unknown> = [];
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const updater = yield* make;
        yield* updater.requestPass;
        yield* Deferred.await(started);
        yield* updater.runPass;
        assert.strictEqual(installs.length, 1);
        yield* Deferred.succeed(release, undefined);
      }).pipe(
        Effect.provide(
          testLayer({
            installs,
            onInstall: Effect.gen(function* () {
              if (installs.length !== 1) return;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }),
          }),
        ),
      );
    }),
  );

  it.effect("a stalled journal does not hold passes, the installer gate, or shutdown", () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const installs: Array<unknown> = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const journalContext = yield* Layer.build(
            Journal.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(ServerConfig, { logsDir: "/synthetic/logs" } as never),
                  NodePath.layer,
                  SecureRandom.layerWebCrypto,
                  Layer.succeed(
                    FileSystem.FileSystem,
                    FileSystem.makeNoop({
                      makeDirectory: () => Effect.void,
                      readDirectory: () => Effect.succeed([]),
                      stat: () => Effect.succeed({ size: 0 } as never),
                      writeFile: () =>
                        Deferred.succeed(writing, undefined).pipe(
                          Effect.andThen(Effect.never),
                          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                        ),
                    }),
                  ),
                ),
              ),
            ),
          );
          const journal = Context.get(journalContext, ProviderUpdateJournal);
          const gate = yield* Gate.make.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.mock(InstallLock.ProviderInstallLock)({
                  tryRun: (_key, run) => run(() => Effect.void).pipe(Effect.asSome),
                  anyHeld: Effect.succeed(false),
                  keyHeld: () => Effect.succeed(false),
                }),
                Layer.mock(InstanceRegistry.ProviderInstanceRegistry)({
                  getInstance: () =>
                    Effect.succeed({
                      snapshot: {
                        resolveMaintenance: () =>
                          Effect.succeed({
                            packageName: "@openai/codex",
                            update: { lockKey: targets.codex!.lockKey },
                          }),
                      },
                    } as never),
                }),
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const updater = yield* make;
            yield* updater.runPass;
            assert.strictEqual(yield* gate.installsInFlight, 0);
            yield* gate.awaitInstance(codex.instanceId);
            yield* updater.runPass;
            assert.strictEqual(installs.length, 1);
          }).pipe(
            Effect.provide(
              testLayer({
                journal,
                gate,
                installs,
                onInstall: Effect.gen(function* () {
                  yield* Deferred.await(writing);
                  for (let index = 0; index < 256; index++)
                    yield* journal.record("codex", "codex", { outcome: "started" });
                }),
              }),
            ),
          );
        }),
      );
      assert.isTrue(yield* Deferred.isDone(interrupted));
    }),
  );

  it.effect("installs the verified version once per window", () => {
    const installs: Array<unknown> = [];
    const records: Array<{ reason?: string }> = [];
    return Effect.gen(function* () {
      const updater = yield* make;
      yield* updater.runPass;
      yield* updater.runPass;
      assert.deepStrictEqual(installs, [{ instanceId: "codex", version: "2.0.0" }]);
      assert.strictEqual(records.at(-1)?.reason, "retry_backoff");
    }).pipe(Effect.provide(testLayer({ installs, records })));
  });

  it.effect("records due versions and why each pass left the provider alone", () =>
    Effect.gen(function* () {
      for (const [fixture, reason, due] of [
        [{ provider: withAdvisory({ canInstallVersion: false }) }, "installer_cannot_pin", true],
        [{ provider: withAdvisory({ canUpdate: false }) }, "update_unavailable", true],
        [{ provider: { ...codex, status: "error" as const } }, "provider_unhealthy", true],
        [{ provider: { ...codex, enabled: false } }, "provider_disabled", true],
        [{ provider: { ...codex, installed: false } }, "not_installed", true],
        [{ provider: { ...codex, version: null } }, "unknown_current_version", null],
        [{ provider: { ...codex, version: "2.0.0" } }, "already_current_or_newer", false],
        [{ manifestAgeMs: null }, "no_recent_verified_target", null],
        [
          { threadStatuses: ["running"] },
          "a thread using this provider CLI is running or waiting",
          true,
        ],
        [
          { refreshed: { ...codex, version: "2.0.0" } },
          "the provider is already updated or no longer healthy",
          true,
        ],
      ] as const) {
        const records: Array<unknown> = [];
        yield* runPassWith({ ...fixture, records, installs: [] });
        assert.deepStrictEqual(records, [
          {
            instanceId: "codex",
            driver: "codex",
            currentVersion: "provider" in fixture ? fixture.provider.version : "1.0.0",
            targetVersion: "manifestAgeMs" in fixture ? null : "2.0.0",
            updateDue: due,
            outcome: "skipped",
            reason,
          },
        ]);
      }
    }),
  );

  it.effect("records a failed capability check", () => {
    const records: Array<unknown> = [];
    return runPassWith({ checkFails: true, records, installs: [] }).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          assert.deepStrictEqual(records, [
            {
              instanceId: "codex",
              driver: "codex",
              currentVersion: "1.0.0",
              targetVersion: null,
              updateDue: null,
              outcome: "failed",
              reason: "check_failed",
            },
          ]),
        ),
      ),
    );
  });

  it.effect("waits while a thread is running or waiting on the user", () => {
    const installs: Array<unknown> = [];
    return Effect.gen(function* () {
      yield* runPassWith({ threadStatuses: ["running"], installs });
      yield* runPassWith({ threadStatuses: ["waiting"], installs });
      assert.deepStrictEqual(installs, []);
      yield* runPassWith({ threadStatuses: ["completed"], installs });
      assert.strictEqual(installs.length, 1);
    });
  });

  it.effect("is not held back by threads on other provider CLIs or archived threads", () => {
    const installs: Array<unknown> = [];
    const snapshotReads: Array<unknown> = [];
    return runPassWith({
      otherThreads: [
        { providerInstanceId: "claude", status: "running" },
        { providerInstanceId: "claude", status: "waiting" },
        { providerInstanceId: "removed", status: "running" },
      ],
      snapshotReads,
      installs,
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.strictEqual(installs.length, 1);
          // Before the pass and again under the install lock; archived threads have no session.
          const read = { location: "active", busyOnly: true };
          assert.deepStrictEqual(snapshotReads, [read, read]);
        }),
      ),
    );
  });

  it.effect("waits for another instance of the same CLI with a pending approval", () => {
    const installs: Array<unknown> = [];
    return runPassWith({
      otherThreads: [
        {
          providerInstanceId: "codex_work",
          status: "completed",
          pendingRuntimeRequest: { ...pendingQuestion(0), kind: "command" },
        },
      ],
      installs,
    }).pipe(Effect.tap(() => Effect.sync(() => assert.deepStrictEqual(installs, []))));
  });

  it.effect("ignores a question left pending over an hour after its run finished", () => {
    const installs: Array<unknown> = [];
    const leftover = (createdAtMs: number): FixtureThread => ({
      id: "subagent-thread",
      providerInstanceId: "codex_work",
      status: "completed",
      pendingRuntimeRequest: pendingQuestion(createdAtMs),
    });
    return Effect.gen(function* () {
      yield* TestClock.adjust(2 * HOUR_MS);
      yield* runPassWith({ otherThreads: [leftover(HOUR_MS + 1)], installs });
      assert.deepStrictEqual(installs, []);
      yield* runPassWith({ otherThreads: [leftover(HOUR_MS)], installs });
      assert.deepStrictEqual(installs, [{ instanceId: "codex", version: "2.0.0" }]);
    });
  });

  it.effect("waits on a pending question of any age while its run is still active", () => {
    const installs: Array<unknown> = [];
    return Effect.gen(function* () {
      yield* TestClock.adjust(24 * HOUR_MS);
      for (const thread of [
        { status: "running", activityRunStatus: "running" },
        { status: "waiting", activityRunStatus: "waiting" },
        // A newer run is starting while the latest presented run is finished.
        { status: "completed", activityRunStatus: "starting" },
      ]) {
        yield* runPassWith({
          otherThreads: [
            { providerInstanceId: "codex", ...thread, pendingRuntimeRequest: pendingQuestion(0) },
          ],
          installs,
        });
      }
      assert.deepStrictEqual(installs, []);
    });
  });

  it.effect("counts updates skipped for a busy CLI until the count is taken", () => {
    const installs: Array<unknown> = [];
    return Effect.gen(function* () {
      const updater = yield* make;
      // Busy when the pass looks, then idle when it looks, busy inside the lock.
      yield* updater.runPass;
      yield* updater.runPass;
      assert.deepStrictEqual(installs, []);
      assert.deepStrictEqual([...(yield* updater.takeBusySkips)], [["codex", 2]]);
      assert.deepStrictEqual([...(yield* updater.takeBusySkips)], []);
    }).pipe(Effect.provide(testLayer({ threadStatuses: ["running", null, "running"], installs })));
  });

  it.effect("drops an update when a turn starts before the install, and retries next pass", () => {
    const installs: Array<unknown> = [];
    return Effect.gen(function* () {
      const updater = yield* make;
      // Idle when the pass looks, busy when the runner checks inside the lock.
      yield* updater.runPass;
      assert.deepStrictEqual(installs, []);
      yield* updater.runPass;
      assert.strictEqual(installs.length, 1);
    }).pipe(Effect.provide(testLayer({ threadStatuses: [null, "running", null], installs })));
  });

  it.effect("skips an install already at the version when the lock is acquired", () => {
    const installs: Array<unknown> = [];
    return runPassWith({ refreshed: { ...codex, version: "2.0.0" }, installs }).pipe(
      Effect.tap(() => Effect.sync(() => assert.deepStrictEqual(installs, []))),
    );
  });

  it.effect("takes over an install already on the verified version once per window", () => {
    const installs: Array<unknown> = [];
    return Effect.gen(function* () {
      const updater = yield* make;
      yield* updater.runPass;
      yield* updater.runPass;
      assert.deepStrictEqual(installs, [{ instanceId: "codex", version: "2.0.0", takeover: true }]);
    }).pipe(
      Effect.provide(
        testLayer({
          provider: { ...codex, version: "2.0.0" },
          selfUpdaterActive: true,
          freshSelfUpdaterActive: true,
          installs,
        }),
      ),
    );
  });

  it.effect("drops a takeover once the provider's own updater is off or the version moved", () => {
    const installs: Array<unknown> = [];
    const current = { ...codex, version: "2.0.0" };
    return Effect.gen(function* () {
      // Already handed over: nothing to do.
      yield* runPassWith({ provider: current, selfUpdaterActive: false, installs });
      // A cached read still saw the updater; the fresh one under the lock does not.
      yield* runPassWith({
        provider: current,
        selfUpdaterActive: true,
        freshSelfUpdaterActive: false,
        installs,
      });
      // Codex's own updater moved past the verified version meanwhile.
      yield* runPassWith({
        provider: current,
        refreshed: { ...codex, version: "2.1.0" },
        selfUpdaterActive: true,
        freshSelfUpdaterActive: true,
        installs,
      });
      assert.deepStrictEqual(installs, []);
    });
  });

  it.effect("does nothing without a recently fetched manifest", () => {
    const installs: Array<unknown> = [];
    return Effect.gen(function* () {
      yield* runPassWith({ manifestAgeMs: null, installs });
      yield* runPassWith({ manifestAgeMs: 3 * 24 * 60 * 60 * 1_000, installs });
      assert.deepStrictEqual(installs, []);
    });
  });

  it.effect("ignores versions verified for another package or a newer styal release", () => {
    const installs: Array<unknown> = [];
    return Effect.gen(function* () {
      yield* runPassWith({
        manifest: manifestWith([
          { version: "2.0.0", package: "@openai/codex-next", styal: "0.0.1" },
        ]),
        installs,
      });
      yield* runPassWith({
        manifest: manifestWith([{ version: "2.0.0", package: "@openai/codex", styal: "99.0.0" }]),
        installs,
      });
      assert.deepStrictEqual(installs, []);
    });
  });

  it.effect(
    "does nothing on dev servers or when automatic updates or update checks are off",
    () => {
      const installs: Array<unknown> = [];
      const capabilityReads: Array<unknown> = [];
      return Effect.gen(function* () {
        yield* runPassWith({
          settings: { autoUpdateProviders: false },
          checkFails: true,
          capabilityReads,
          records: [],
          installs,
        });
        yield* runPassWith({
          settings: { enableProviderUpdateChecks: false },
          capabilityReads,
          installs,
        });
        yield* runPassWith({ devUrl: "http://localhost:5173", capabilityReads, installs });
        assert.deepStrictEqual(installs, []);
        assert.deepStrictEqual(capabilityReads, []);
      });
    },
  );
});
