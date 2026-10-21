import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as Schema from "effect/Schema";
import {
  applyProviderCompatibility,
  ProviderCompatibilityPolicy,
  resolveProviderAutoUpdateVersion,
  styalBuildContains,
  resolveProviderCompatibility,
} from "./providerCompatibility.ts";

const driver = ProviderDriverKind.make("codex");
const policy: ProviderCompatibilityPolicy = {
  driver,
  t3CodeRange: ">=0.0.0",
  recommendedVersion: "2.0.0",
  recommendedRange: ">=2.0.0 <3.0.0",
  ranges: [
    { range: "<1.0.0", status: "broken" },
    { range: ">=1.0.0 <1.5.0", status: "unsupported" },
    { range: ">=1.5.0 <2.0.0", status: "graceful" },
    { range: ">=2.0.0 <3.0.0", status: "supported" },
  ],
};
const provider: ServerProvider = {
  driver,
  instanceId: ProviderInstanceId.make("codex-work"),
  enabled: true,
  installed: true,
  version: "0.9.0",
  status: "error",
  message: "Authentication failed",
  checkedAt: "2026-09-22T00:00:00Z",
  auth: { status: "unauthenticated" },
  models: [],
  skills: [],
  slashCommands: [],
};

describe("provider compatibility", () => {
  it("keeps releases before V2 on the OpenCode 1 policy they shipped with", () => {
    // Every installed build fetches main's manifest, and styal 0.1.0 and older run the
    // V1 orchestrator, which cannot drive OpenCode 2.
    const opencode = ProviderDriverKind.make("opencode");
    for (const [version, expected] of [
      ["1.14.19", "supported"],
      ["2.0.18", "broken"],
      ["1.14.18", "broken"],
    ] as const) {
      const advisory = resolveProviderCompatibility(
        ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
        opencode,
        version,
        "0.1.0",
      );
      assert.strictEqual(advisory?.status, expected, `OpenCode ${version} on 0.1.0`);
      assert.strictEqual(advisory?.recommendedVersion, "1.14.19");
    }
    assert.isUndefined(
      resolveProviderCompatibility(
        ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
        ProviderDriverKind.make("pi"),
        "1.0.0",
        "0.1.0",
      ),
    );
  });

  it("compares Cursor build dates without treating semver prereleases as stable", () => {
    const cursor = ProviderDriverKind.make("cursor");
    const cursorPolicy: ProviderCompatibilityPolicy = {
      driver: cursor,
      t3CodeRange: policy.t3CodeRange,
      ranges: [
        { range: "<2026.05.09", status: "unsupported" },
        { range: ">=2026.05.09", status: "supported" },
      ],
    };
    for (const [version, expected] of [
      ["2026.05.08-a1b2c3d", "unsupported"],
      ["2026.05.09-a1b2c3d", "supported"],
      ["2026.09.22-f2b0fcd", "supported"],
      ["2026.05.09", "supported"],
      ["2026.05.09-beta.1", "unknown"],
    ] as const) {
      assert.strictEqual(
        resolveProviderCompatibility([cursorPolicy], cursor, version)?.status,
        expected,
      );
    }
    assert.strictEqual(
      resolveProviderCompatibility([policy], driver, "2.0.0-a1b2c3d")?.status,
      "unknown",
    );
  });

  it("recognizes Antigravity semver release tags while keeping dated candidates unknown", () => {
    const antigravity = ProviderDriverKind.make("antigravity");
    const taggedPolicy = {
      ...policy,
      driver: antigravity,
      ranges: [{ range: "=2.0.0", status: "supported" as const }],
    };
    for (const [version, expected] of [
      ["agy_acp_server_2.0.0", "supported"],
      ["2.0.0", "supported"],
      ["agy_acp_server_2.0.1", "unknown"],
      ["agy_acp_server_2.0.0-beta.1", "unknown"],
      ["agy_acp_server_20260818_01_RC01", "unknown"],
    ] as const) {
      assert.strictEqual(
        resolveProviderCompatibility([taggedPolicy], antigravity, version)?.status,
        expected,
      );
    }
  });

  it("classifies boundaries and treats unlisted versions and release tags as unknown", () => {
    for (const [version, expected] of [
      ["0.9.9", "broken"],
      ["1.0.0", "unsupported"],
      ["1.5.0", "graceful"],
      ["2.0.0", "supported"],
      ["v2.0.0", "supported"],
      ["3.0.0", "unknown"],
      ["2.0.0-beta.1", "unknown"],
      ["agy_acp_server_20260818_01_RC01", "unknown"],
      [null, "unknown"],
    ] as const) {
      assert.strictEqual(resolveProviderCompatibility([policy], driver, version)?.status, expected);
    }
  });

  it("applies policies only within their T3 Code version range", () => {
    const scopedPolicy = { ...policy, t3CodeRange: ">=0.0.42 <0.1.0" };
    for (const version of ["0.0.42", "0.0.45"]) {
      assert.strictEqual(
        resolveProviderCompatibility([scopedPolicy], driver, "0.9.0", version)?.status,
        "broken",
      );
    }
    for (const version of ["0.0.41", "0.1.0"]) {
      assert.isUndefined(resolveProviderCompatibility([scopedPolicy], driver, "0.9.0", version));
    }
  });

  it("relaxes remote policy without losing probe errors, and falls back when a policy is omitted", () => {
    const broken = applyProviderCompatibility(provider, [], [policy]);
    assert.strictEqual(broken.compatibilityAdvisory?.status, "broken");
    const relaxed = { ...policy, ranges: [{ range: ">=0.0.0", status: "supported" as const }] };
    const supported = applyProviderCompatibility(broken, [relaxed], [policy]);
    assert.strictEqual(supported.compatibilityAdvisory?.status, "supported");
    assert.strictEqual(supported.status, "error");
    assert.strictEqual(supported.message, "Authentication failed");
    assert.strictEqual(
      applyProviderCompatibility(supported, [{ ...policy, t3CodeRange: "<0.0.0" }], [policy])
        .compatibilityAdvisory?.status,
      "broken",
    );
    const removed = applyProviderCompatibility(supported, [], []);
    assert.isUndefined(removed.compatibilityAdvisory);
    assert.strictEqual(removed.status, "error");
    assert.strictEqual(removed.message, "Authentication failed");
    assert.isUndefined(
      applyProviderCompatibility({ ...broken, enabled: false }, [], [policy]).compatibilityAdvisory,
    );
    assert.isUndefined(
      applyProviderCompatibility({ ...broken, installed: false }, [], [policy])
        .compatibilityAdvisory,
    );
  });

  it("rejects invalid ranges and recommendations outside the first supported match", () => {
    const decode = Schema.decodeUnknownSync(ProviderCompatibilityPolicy);
    assert.doesNotThrow(() => decode(policy));
    const prefixed = decode({
      ...policy,
      t3CodeRange: ">=v0.0.42 <v0.1",
      recommendedRange: "^v2",
      ranges: [{ range: ">=v2.0 <v3", status: "supported" }],
    });
    assert.strictEqual(
      resolveProviderCompatibility([prefixed], driver, "2.0.0", "0.0.45")?.status,
      "supported",
    );
    assert.strictEqual(
      resolveProviderCompatibility([prefixed], driver, "3.0.0", "0.0.45")?.status,
      "unknown",
    );
    for (const invalid of [
      { ...policy, t3CodeRange: "*" },
      { ...policy, recommendedVersion: "3.0.0" },
      { ...policy, ranges: [{ range: ">=2.0.0 garbage", status: "supported" }] },
      { ...policy, recommendedVersion: "2.0.0; echo unsafe" },
      { ...policy, ranges: [{ range: ">=0.0.0", status: "broken" }, ...policy.ranges] },
      { ...policy, autoUpdates: [{ version: "1.6.0", package: "pkg", styal: "0.0.42" }] },
      { ...policy, autoUpdates: [{ version: "2.1.0-beta.1", package: "pkg", styal: "0.0.42" }] },
      { ...policy, autoUpdates: [{ version: "2.1.0", package: "pkg", styal: "latest" }] },
    ])
      assert.throws(() => decode(invalid));
  });

  it("treats a build as containing tested nightlies before it and stables at or before it", () => {
    const nightly = "0.1.1-nightly.20261015.730";
    assert.isTrue(styalBuildContains(nightly, nightly));
    assert.isTrue(styalBuildContains("0.1.1-nightly.20261016.731", nightly));
    assert.isFalse(styalBuildContains("0.1.1-nightly.20261014.700", nightly));
    // Stable 0.1.1 may be rebuilt from a nightly older than the tested one.
    assert.isFalse(styalBuildContains("0.1.1", nightly));
    assert.isTrue(styalBuildContains("0.1.2", nightly));
    assert.isTrue(styalBuildContains("0.1.1", "0.1.1"));
    assert.isTrue(styalBuildContains("0.1.2-nightly.20261020.760", "0.1.1"));
    assert.isFalse(styalBuildContains("0.1.1-nightly.20261020.760", "0.1.1"));
    assert.isFalse(styalBuildContains("0.1.0", "0.1.1"));
  });

  it("picks the newest verified version that applies to this styal build and package", () => {
    const decode = Schema.decodeUnknownSync(ProviderCompatibilityPolicy);
    const verified = decode({
      ...policy,
      t3CodeRange: ">=0.0.42",
      autoUpdates: [
        { version: "2.0.0", package: "pkg", styal: "0.1.0" },
        { version: "2.4.1", package: "pkg", styal: "0.1.1-nightly.20261015.730" },
        { version: "2.9.0", package: "other-pkg", styal: "0.1.0" },
      ],
    });
    const resolve = (t3CodeVersion: string, packageName: string | null = "pkg") =>
      resolveProviderAutoUpdateVersion([verified], driver, packageName, t3CodeVersion);
    assert.strictEqual(resolve("0.1.1-nightly.20261016.731"), "2.4.1");
    assert.strictEqual(resolve("0.1.1-nightly.20261015.730"), "2.4.1");
    // An older nightly lacks the tested nightly but contains stable 0.1.0.
    assert.strictEqual(resolve("0.1.1-nightly.20261014.700"), "2.0.0");
    assert.strictEqual(resolve("0.1.1"), "2.0.0");
    assert.strictEqual(resolve("0.1.0"), "2.0.0");
    assert.strictEqual(resolve("0.0.45"), null);
    assert.strictEqual(resolve("0.1.1", "other-pkg"), "2.9.0");
    assert.strictEqual(resolve("0.1.1", null), null);
  });
});

it.effect("a remote policy refresh preserves a newer health result on the registry stream", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const health = yield* Ref.make<ServerProvider>({
      ...provider,
      status: "ready" as ServerProvider["status"],
      message: "Healthy",
    });
    const manifest = yield* Ref.make<ModelManifest.ModelManifestData>({
      version: 1,
      currentModels: {},
      compatibility: [policy],
    });
    const instance: ProviderInstance = {
      instanceId: provider.instanceId,
      driverKind: driver,
      enabled: true,
      displayName: undefined,
      continuationIdentity: { driverKind: driver, continuationKey: "test-codex" },
      snapshot: {
        getSnapshot: Ref.get(health),
        refresh: Ref.get(health),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: null }),
          ),
      },
      orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    };
    const refresh = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.andThen(
        Ref.updateAndGet(manifest, (current) => ({
          ...current,
          compatibility: [
            { ...policy, ranges: [{ range: ">=0.0.0", status: "supported" as const }] },
          ],
        })),
      ),
    );
    const layerDependencies = Layer.mergeAll(
      ProviderLatestVersions.layer,
      Layer.succeed(ModelManifest.ModelManifest, {
        current: Ref.get(manifest),
        refresh,
        forceRefresh: refresh,
        refreshInBackground: Effect.void,
        remote: Effect.succeed(null),
      }),
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (id) => Effect.succeed(id === instance.instanceId ? instance : undefined),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "compatibility-registry-test" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    yield* Effect.gen(function* () {
      const registry = yield* ProviderRegistry.ProviderRegistry;
      yield* Deferred.await(started);
      assert.strictEqual(
        (yield* registry.getProviders)[0]?.compatibilityAdvisory?.status,
        "broken",
      );
      yield* Ref.set(health, provider);
      const latestHealth = yield* registry.refreshInstance(provider.instanceId);
      assert.strictEqual(latestHealth[0]?.message, "Authentication failed");
      const supported = yield* Stream.toPull(
        registry.streamChanges.pipe(
          Stream.filter((snapshots) => snapshots[0]?.compatibilityAdvisory?.status === "supported"),
        ),
      );
      const subscribed = yield* supported.pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      const updated = (yield* Fiber.join(subscribed))[0]?.[0];
      assert.strictEqual(updated?.compatibilityAdvisory?.status, "supported");
      assert.strictEqual(updated?.status, "error");
      assert.strictEqual(updated?.message, "Authentication failed");
    }).pipe(Effect.provide(ProviderRegistry.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.scoped),
);

it.effect("publishes the verified version from a recent remote manifest", () =>
  Effect.gen(function* () {
    const healthy: ServerProvider = { ...provider, version: "2.1.0", status: "ready" };
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      compatibility: [
        {
          ...policy,
          t3CodeRange: ">=0.0.0",
          autoUpdates: [{ version: "2.4.0", package: "pkg", styal: "0.0.1" }],
        },
      ],
    };
    const instance: ProviderInstance = {
      instanceId: provider.instanceId,
      driverKind: driver,
      enabled: true,
      displayName: undefined,
      continuationIdentity: { driverKind: driver, continuationKey: "test-codex" },
      snapshot: {
        getSnapshot: Effect.succeed(healthy),
        refresh: Effect.succeed(healthy),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: "pkg" }),
          ),
      },
      orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    };
    const dependencies = Layer.mergeAll(
      ProviderLatestVersions.layer,
      Layer.succeed(ModelManifest.ModelManifest, {
        current: Effect.succeed(manifest),
        refresh: Effect.succeed(manifest),
        forceRefresh: Effect.succeed(manifest),
        refreshInBackground: Effect.void,
        remote: Effect.succeed({ manifest, fetchedAtMs: 0 }),
      }),
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (id) => Effect.succeed(id === instance.instanceId ? instance : undefined),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "compatibility-verified-test" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    yield* Effect.gen(function* () {
      const registry = yield* ProviderRegistry.ProviderRegistry;
      const fresh = yield* registry.refreshInstance(provider.instanceId);
      assert.strictEqual(fresh[0]?.compatibilityAdvisory?.verifiedVersion, "2.4.0");
      // A manifest older than two days may list a withdrawn version.
      yield* TestClock.adjust("3 days");
      const stale = yield* registry.refreshInstance(provider.instanceId);
      assert.strictEqual(stale[0]?.compatibilityAdvisory?.status, "supported");
      assert.strictEqual(stale[0]?.compatibilityAdvisory?.verifiedVersion, undefined);
    }).pipe(Effect.provide(ProviderRegistry.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.scoped),
);
