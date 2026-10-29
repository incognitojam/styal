import {
  EnvironmentId,
  OrchestrationV2GetShellSnapshotError,
  WS_METHODS,
  type HostActivity,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const LAB = EnvironmentId.make("lab");
const OFFICE = EnvironmentId.make("office");
const ACTIVITY: HostActivity = {
  activeSessions: 1,
  continuableSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
  environmentsUsingDevices: 0,
};

const makeHarness = Effect.fn("HostActivityTest.makeHarness")(function* () {
  const started = yield* Queue.unbounded<EnvironmentId>();
  const completion = yield* Deferred.make<HostActivity, OrchestrationV2GetShellSnapshotError>();
  const reads: EnvironmentId[] = [];
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(),
  );
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.mock(Persistence.EnvironmentCacheStore)({}),
      Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
        entries,
        networkStatus,
        run: (environmentId, effect) =>
          Effect.gen(function* () {
            const session = yield* SubscriptionRef.make(
              Option.some({
                client: {
                  [WS_METHODS.serverGetHostActivity]: () =>
                    Effect.gen(function* () {
                      reads.push(environmentId);
                      yield* Queue.offer(started, environmentId);
                      return yield* Deferred.await(completion);
                    }),
                },
              } as unknown as RpcSession),
            );
            const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected",
            });
            const prepared = yield* SubscriptionRef.make(Option.none<PreparedConnection>());
            return yield* effect.pipe(
              Effect.provide(
                Layer.mock(EnvironmentSupervisor.EnvironmentSupervisor)({
                  target: new PrimaryConnectionTarget({
                    environmentId,
                    label: "Test environment",
                    httpBaseUrl: "https://environment.example.test",
                    wsBaseUrl: "wss://environment.example.test",
                  }),
                  session,
                  state,
                  prepared,
                }),
              ),
            );
          }),
      }),
    ),
  );
  const command = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: () => Atom.make(null),
  }).hostActivity;
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return {
    started,
    completion,
    reads,
    read: (environmentId = LAB) => command.run(registry, { environmentId, input: {} }),
  };
});

it.effect("joins a running host check and reads fresh activity after it completes", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const original = h.read();
    expect(yield* Queue.take(h.started)).toBe(LAB);
    const retry = h.read();
    expect(h.reads).toEqual([LAB]);
    yield* Deferred.succeed(h.completion, ACTIVITY);
    const first = yield* Effect.promise(() => original);
    expect(first).toMatchObject({ _tag: "Success", value: ACTIVITY });
    expect(yield* Effect.promise(() => retry)).toBe(first);
    expect(h.reads).toEqual([LAB]);

    const fresh = h.read();
    expect(yield* Queue.take(h.started)).toBe(LAB);
    expect(yield* Effect.promise(() => fresh)).toMatchObject({ _tag: "Success" });
    expect(h.reads).toEqual([LAB, LAB]);
  }).pipe(Effect.scoped),
);

it.effect("shares a failed check and allows a new attempt after failure", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const original = h.read();
    yield* Queue.take(h.started);
    const retry = h.read();
    yield* Deferred.fail(
      h.completion,
      new OrchestrationV2GetShellSnapshotError({ message: "Read failed" }),
    );
    const first = yield* Effect.promise(() => original);
    expect(first._tag).toBe("Failure");
    expect(yield* Effect.promise(() => retry)).toBe(first);
    expect(h.reads).toEqual([LAB]);

    const fresh = h.read();
    yield* Queue.take(h.started);
    expect((yield* Effect.promise(() => fresh))._tag).toBe("Failure");
    expect(h.reads).toEqual([LAB, LAB]);
  }).pipe(Effect.scoped),
);

it.effect("checks separate environments independently", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const lab = h.read(LAB);
    expect(yield* Queue.take(h.started)).toBe(LAB);
    const office = h.read(OFFICE);
    expect(yield* Queue.take(h.started)).toBe(OFFICE);
    yield* Deferred.succeed(h.completion, ACTIVITY);
    expect((yield* Effect.promise(() => lab))._tag).toBe("Success");
    expect((yield* Effect.promise(() => office))._tag).toBe("Success");
    expect(h.reads).toEqual([LAB, OFFICE]);
  }).pipe(Effect.scoped),
);
