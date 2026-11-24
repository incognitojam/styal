import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";
import * as Connectivity from "./connectivity.ts";
import { watchDirectCompatibility } from "./directCompatibility.ts";
import {
  BearerConnectionTarget,
  type ConnectionBlockedError,
  type NetworkStatus,
} from "./model.ts";
import { ApplicationPresence, type ApplicationPresenceState } from "./presence.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-studio"),
  label: "studio-box",
  connectionId: "studio-lan",
});
const profile = (connectionId: string, host: string) =>
  Option.some(
    new BearerConnectionProfile({
      connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: `https://${host}`,
      wsBaseUrl: `wss://${host}`,
    }),
  );

const descriptor = (
  protocol: number,
  capabilities: ExecutionEnvironmentDescriptor["capabilities"] = { repositoryIdentity: true },
): ExecutionEnvironmentDescriptor => ({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  platform: { os: "linux", arch: "x64" },
  serverVersion: "1.0.0",
  orchestrationProtocolVersion: protocol,
  capabilities,
});
const NEWER = descriptor(ORCHESTRATION_PROTOCOL_VERSION + 1);
const COMPATIBLE = descriptor(ORCHESTRATION_PROTOCOL_VERSION);
const encodeDescriptor = Schema.encodeSync(Schema.fromJsonString(ExecutionEnvironmentDescriptor));

const blockedBy = (served: ExecutionEnvironmentDescriptor): ConnectionCatalogEntry => {
  const error = orchestrationProtocolCompatibilityError(served);
  return {
    target: TARGET,
    profile: profile(TARGET.connectionId, "studio.example.test"),
    enabled: true,
    ...(error === null ? {} : { unsupportedReason: error.message }),
  };
};

/** Serves each host's descriptor, a slow host a second late; a host with none never answers. */
const makeHarness = Effect.fn("TestDirectCompatibility.makeHarness")(function* (
  entry: ConnectionCatalogEntry,
  initiallyServed:
    | ExecutionEnvironmentDescriptor
    | ReadonlyMap<string, ExecutionEnvironmentDescriptor>
    | null,
  slow: ReadonlySet<string> = new Set(),
) {
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([[TARGET.environmentId, entry]]),
  );
  const served = yield* Ref.make<ReadonlyMap<string, ExecutionEnvironmentDescriptor>>(
    initiallyServed === null
      ? new Map()
      : initiallyServed instanceof Map
        ? initiallyServed
        : new Map([["studio.example.test", initiallyServed as ExecutionEnvironmentDescriptor]]),
  );
  const requests = yield* Queue.unbounded<string>();
  const interrupted = yield* Queue.unbounded<string>();
  const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
  const network = yield* Ref.make<NetworkStatus>("online");
  const networkChanges = yield* Queue.unbounded<NetworkStatus>();
  const presence = yield* Ref.make<ApplicationPresenceState>("foreground");
  const presenceChanges = yield* Queue.unbounded<ApplicationPresenceState>();

  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries,
    setCompatibility: (environmentId: EnvironmentId, error: ConnectionBlockedError | null) =>
      SubscriptionRef.update(entries, (current) => {
        const existing = current.get(environmentId);
        if (existing === undefined) return current;
        const { unsupportedReason: _reason, serverUpdateRequired: _update, ...rest } = existing;
        return new Map(current).set(
          environmentId,
          error === null
            ? rest
            : {
                ...rest,
                unsupportedReason: error.message,
                ...(error.serverUpdateRequired === true ? { serverUpdateRequired: true } : {}),
              },
        );
      }),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      const host = new URL(request.url).host;
      yield* Queue.offer(requests, host);
      const answer = (yield* Ref.get(served)).get(host);
      if (answer === undefined) return yield* Effect.never;
      if (slow.has(host)) yield* Effect.sleep("1 second");
      return HttpClientResponse.fromWeb(request, new Response(encodeDescriptor(answer)));
    }).pipe(Effect.onInterrupt(() => Queue.offer(interrupted, new URL(request.url).host))),
  );

  const start = (scope: Scope.Scope) =>
    watchDirectCompatibility().pipe(
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(
        ConnectionWakeups.ConnectionWakeups,
        ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
      ),
      Effect.provideService(
        Connectivity.Connectivity,
        Connectivity.Connectivity.of({
          status: Ref.get(network),
          changes: Stream.fromQueue(networkChanges),
        }),
      ),
      Effect.provideService(ApplicationPresence, {
        current: Ref.get(presence),
        changes: Stream.fromQueue(presenceChanges),
      }),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.forkIn(scope),
    );

  return {
    entries,
    served,
    requests,
    interrupted,
    start,
    wake: Queue.offer(wakeups, "application-active"),
    setNetwork: (status: NetworkStatus) =>
      Ref.set(network, status).pipe(Effect.andThen(Queue.offer(networkChanges, status))),
    setPresence: (state: ApplicationPresenceState) =>
      Ref.set(presence, state).pipe(Effect.andThen(Queue.offer(presenceChanges, state))),
    entry: SubscriptionRef.get(entries).pipe(
      Effect.map((current) => current.get(TARGET.environmentId)),
    ),
    /** The cadence never waits longer than five minutes, so this would run any further sweep. */
    expectNoMoreRequests: Effect.gen(function* () {
      yield* TestClock.adjust("10 minutes");
      expect(yield* Queue.size(requests)).toBe(0);
    }),
  };
});

describe("watchDirectCompatibility", () => {
  it.effect("rechecks on the reconnect cadence until the machine is compatible, then stops", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(blockedBy(NEWER), NEWER);
      yield* harness.start(yield* Effect.scope);
      expect(yield* Queue.take(harness.requests)).toBe("studio.example.test");
      // The first wait is at most two seconds, like the first reconnect attempt.
      yield* TestClock.adjust("2 seconds");
      yield* Queue.take(harness.requests);
      expect((yield* harness.entry)?.unsupportedReason).toBeDefined();

      yield* Ref.set(harness.served, new Map([["studio.example.test", COMPATIBLE]]));
      yield* TestClock.adjust("4 seconds");
      yield* Queue.take(harness.requests);
      expect((yield* harness.entry)?.unsupportedReason).toBeUndefined();
      yield* harness.expectNoMoreRequests;
    }).pipe(Effect.scoped),
  );

  it.effect("applies a verdict that is still incompatible but changed sides", () =>
    Effect.gen(function* () {
      const older = descriptor(ORCHESTRATION_PROTOCOL_VERSION - 1, {
        repositoryIdentity: true,
        serverSelfUpdate: "boot-service",
      });
      const harness = yield* makeHarness(blockedBy(NEWER), older);
      yield* harness.start(yield* Effect.scope);
      yield* Queue.take(harness.requests);
      const updated = yield* SubscriptionRef.changes(harness.entries).pipe(
        Stream.map((current) => current.get(TARGET.environmentId)),
        Stream.filter((entry) => entry?.serverUpdateRequired === true),
        Stream.runHead,
      );
      expect(Option.getOrNull(updated)?.unsupportedReason).toBe(
        orchestrationProtocolCompatibilityError(older)?.message,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("sweeps at once on a wakeup", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(blockedBy(NEWER), NEWER);
      yield* harness.start(yield* Effect.scope);
      yield* Queue.take(harness.requests);
      yield* harness.wake;
      yield* Queue.take(harness.requests);
    }).pipe(Effect.scoped),
  );

  it.effect("asks every saved address at once and takes the first answer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        {
          ...blockedBy(NEWER),
          profile: profile(TARGET.connectionId, "studio-silent.example.test"),
          alternateRoutes: [
            {
              target: new BearerConnectionTarget({ ...TARGET, connectionId: "studio-tailnet" }),
              profile: profile("studio-tailnet", "studio.example.test"),
            },
          ],
        },
        COMPATIBLE,
      );
      yield* harness.start(yield* Effect.scope);
      // The silent address would hold a one-at-a-time check until its timeout, which never comes.
      yield* SubscriptionRef.changes(harness.entries).pipe(
        Stream.filter(
          (current) => current.get(TARGET.environmentId)?.unsupportedReason === undefined,
        ),
        Stream.runHead,
      );
      expect((yield* harness.entry)?.unsupportedReason).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("passes over an address that another machine now answers", () =>
    Effect.gen(function* () {
      const other = { ...COMPATIBLE, environmentId: EnvironmentId.make("environment-other") };
      const harness = yield* makeHarness(
        {
          ...blockedBy(NEWER),
          profile: profile(TARGET.connectionId, "old-lan.example.test"),
          alternateRoutes: [
            {
              target: new BearerConnectionTarget({ ...TARGET, connectionId: "studio-tailnet" }),
              profile: profile("studio-tailnet", "studio.example.test"),
            },
          ],
        },
        new Map([
          ["old-lan.example.test", other],
          ["studio.example.test", COMPATIBLE],
        ]),
        new Set(["studio.example.test"]),
      );
      yield* harness.start(yield* Effect.scope);
      yield* Queue.take(harness.requests);
      yield* Queue.take(harness.requests);
      yield* TestClock.adjust("1 second");
      yield* SubscriptionRef.changes(harness.entries).pipe(
        Stream.filter(
          (current) => current.get(TARGET.environmentId)?.unsupportedReason === undefined,
        ),
        Stream.runHead,
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      stop: "hiding the machine",
      apply: (harness: Harness) =>
        SubscriptionRef.update(harness.entries, (current) => {
          const entry = current.get(TARGET.environmentId);
          return entry === undefined
            ? current
            : new Map(current).set(TARGET.environmentId, { ...entry, enabled: false });
        }),
    },
    {
      stop: "removing the machine",
      apply: (harness: Harness) => SubscriptionRef.set(harness.entries, new Map()),
    },
    {
      stop: "going to the background",
      apply: (harness: Harness) => harness.setPresence("background"),
    },
    { stop: "going offline", apply: (harness: Harness) => harness.setNetwork("offline") },
  ])("stops on $stop, interrupting the request in flight", ({ apply }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(blockedBy(NEWER), null);
      yield* harness.start(yield* Effect.scope);
      yield* Queue.take(harness.requests);
      yield* apply(harness);
      expect(yield* Queue.take(harness.interrupted)).toBe("studio.example.test");
      yield* harness.expectNoMoreRequests;
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { back: "returning to the app", leave: "background", resume: "foreground" },
    { back: "coming back online", leave: "offline", resume: "online" },
  ] as const)("sweeps at once on $back", ({ leave, resume }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(blockedBy(NEWER), NEWER);
      yield* harness.start(yield* Effect.scope);
      yield* Queue.take(harness.requests);
      if (leave === "background") yield* harness.setPresence("background");
      else yield* harness.setNetwork(leave);
      yield* harness.expectNoMoreRequests;
      if (resume === "foreground") yield* harness.setPresence(resume);
      else yield* harness.setNetwork(resume);
      yield* Queue.take(harness.requests);
    }).pipe(Effect.scoped),
  );

  it.effect("stops when its scope closes, interrupting the request in flight", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(blockedBy(NEWER), null);
      const scope = yield* Scope.make();
      yield* harness.start(scope);
      yield* Queue.take(harness.requests);
      yield* Scope.close(scope, Exit.void);
      expect(yield* Queue.take(harness.interrupted)).toBe("studio.example.test");
      yield* harness.expectNoMoreRequests;
    }),
  );
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;
