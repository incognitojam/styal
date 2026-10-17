import {
  type ClientNetworkReport,
  EnvironmentId,
  type ReportNetworkConditionsInput,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import * as NetworkReports from "./service.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const TARGET = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const ENTRY: ConnectionCatalogEntry = { target: TARGET, profile: Option.none(), enabled: true };
const CONNECTED: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  phase: "connected",
};

const makeHarness = Effect.fn("NetworkReportsTest.makeHarness")(function* (options: {
  readonly networkReports: boolean;
  readonly stored?: string;
}) {
  const sent = yield* Queue.unbounded<ReadonlyArray<ClientNetworkReport>>();
  const saved = yield* Queue.unbounded<string>();
  const configRead = yield* Deferred.make<void>();
  const active = yield* Queue.unbounded<boolean>();
  const config = {
    environment: { capabilities: { networkReports: options.networkReports } },
  } as ServerConfig;
  const client = {
    [WS_METHODS.serverReportNetworkConditions]: (input: ReportNetworkConditionsInput) =>
      Queue.offer(sent, input.reports),
  } as unknown as WsRpcProtocolClient;
  const session = {
    client,
    initialConfig: Deferred.succeed(configRead, undefined).pipe(Effect.as(config)),
    subscribeServerConfig: () => Stream.empty,
    ready: Effect.void,
    probe: Effect.void,
    receivedFrames: Effect.succeed(0),
    closed: Effect.never,
  } satisfies RpcSession;
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(CONNECTED);
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state,
    session: yield* SubscriptionRef.make(Option.some<RpcSession>(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([[ENVIRONMENT_ID, ENTRY]]),
  );
  const context = yield* NetworkReports.make.pipe(
    Effect.provideService(NetworkReports.NetworkReportsPlatform, {
      networkKind: Stream.make("cellular"),
      active: Stream.fromQueue(active),
      store: {
        load: Effect.succeed(Option.fromUndefinedOr(options.stored)),
        save: (document) => Queue.offer(saved, document),
      },
    }),
  );
  const service = Context.get(context, NetworkReports.NetworkReports);
  yield* service.follow({
    entries,
    state: () => SubscriptionRef.get(state),
    stateChanges: () => SubscriptionRef.changes(state),
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  });
  // Let the followers subscribe before the test moves the clock.
  yield* Effect.yieldNow;
  return { service, sent, saved, configRead, active, state, entries };
});

// Closes the current window by sending the app to the background, then
// brings it back so the next window can start.
const finishWindow = Effect.fn("NetworkReportsTest.finishWindow")(function* (
  active: Queue.Queue<boolean>,
  duration: Duration.Input,
) {
  yield* TestClock.adjust(duration);
  yield* Queue.offer(active, false);
  yield* Queue.offer(active, true);
});

describe("NetworkReports", () => {
  it.effect("sends each finished window once, dated by when it ended", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ networkReports: true });
      yield* finishWindow(harness.active, "10 seconds");

      const first = yield* Queue.take(harness.sent);
      expect(first).toEqual([
        expect.objectContaining({
          networkKind: "cellular",
          durationMs: 10_000,
          connectedMs: 10_000,
          endedAgoMs: 0,
        }),
      ]);
      expect((yield* SubscriptionRef.get(harness.service.reports)).map((r) => r.delivered)).toEqual(
        [true],
      );

      // A reconnection does not resend it; the next window goes out alone.
      yield* SubscriptionRef.set(harness.state, { ...CONNECTED, generation: 2 });
      yield* finishWindow(harness.active, "20 seconds");
      const second = yield* Queue.take(harness.sent);
      expect(second.map((report) => report.durationMs)).toEqual([20_000]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps reports on the device when the server does not accept them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ networkReports: false });
      yield* finishWindow(harness.active, "10 seconds");

      yield* Queue.take(harness.saved);
      yield* Deferred.await(harness.configRead);
      yield* Effect.yieldNow;
      expect(yield* Queue.size(harness.sent)).toBe(0);
      expect((yield* SubscriptionRef.get(harness.service.reports)).map((r) => r.delivered)).toEqual(
        [false],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("restores saved reports and forgets an environment that is removed", () =>
    Effect.gen(function* () {
      const writer = yield* makeHarness({ networkReports: false });
      yield* finishWindow(writer.active, "10 seconds");
      const document = yield* Queue.take(writer.saved);

      const harness = yield* makeHarness({ networkReports: false, stored: document });
      expect(
        (yield* SubscriptionRef.get(harness.service.reports)).map((report) => report.environmentId),
      ).toEqual([ENVIRONMENT_ID]);

      yield* SubscriptionRef.set(harness.entries, new Map());
      expect(yield* Queue.take(harness.saved)).toBe('{"version":1,"reports":[]}');
      expect(yield* SubscriptionRef.get(harness.service.reports)).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
