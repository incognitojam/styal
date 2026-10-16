import {
  EnvironmentId,
  MAX_NETWORK_REPORT_AGE_MS,
  MAX_NETWORK_REPORTS_PER_REQUEST,
  NetworkReportMetrics,
  type NetworkReportNetworkKind,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionRouteId, preparedConnectionRouteKind } from "../connection/routes.ts";
import * as EnvironmentRpc from "../rpc/client.ts";
import { NetworkReportCollector, type NetworkReportRecord } from "./collector.ts";
import { NetworkMeters } from "./meter.ts";

/** Reports kept per environment, newest first, including ones already sent. */
const MAX_STORED_REPORTS_PER_ENVIRONMENT = 100;
const STORED_DOCUMENT_VERSION = 1;

export const StoredNetworkReport = Schema.Struct({
  environmentId: EnvironmentId,
  startedAt: Schema.Number,
  endedAt: Schema.Number,
  /** Accepted by the environment's server. Servers without the capability never receive one. */
  delivered: Schema.Boolean,
  metrics: NetworkReportMetrics,
});
export type StoredNetworkReport = typeof StoredNetworkReport.Type;

const StoredNetworkReportDocument = Schema.Struct({
  version: Schema.Literal(STORED_DOCUMENT_VERSION),
  reports: Schema.Array(StoredNetworkReport),
});
const StoredNetworkReportDocumentJson = Schema.fromJsonString(StoredNetworkReportDocument);
const decodeDocument = Schema.decodeUnknownOption(StoredNetworkReportDocumentJson);
const encodeDocument = Schema.encodeSync(StoredNetworkReportDocumentJson);

/**
 * What the platform knows about the device. The streams emit the current value
 * first, then changes. Without them every window is foreground time on an
 * unknown network and reports live only in memory.
 */
export class NetworkReportsPlatform extends Context.Reference<{
  readonly networkKind: Stream.Stream<NetworkReportNetworkKind>;
  readonly active: Stream.Stream<boolean>;
  /** Keeps the encoded reports of every environment as one document. */
  readonly store: {
    readonly load: Effect.Effect<Option.Option<string>>;
    readonly save: (document: string) => Effect.Effect<void>;
  };
}>("@t3tools/client-runtime/networkReports/service/NetworkReportsPlatform", {
  defaultValue: () => ({
    networkKind: Stream.empty,
    active: Stream.empty,
    store: { load: Effect.succeedNone, save: () => Effect.void },
  }),
}) {}

type FollowedRegistry = Pick<
  EnvironmentRegistry["Service"],
  "entries" | "state" | "stateChanges" | "run"
>;

export class NetworkReports extends Context.Service<
  NetworkReports,
  {
    /** Every environment's reports, newest first. */
    readonly reports: SubscriptionRef.SubscriptionRef<ReadonlyArray<StoredNetworkReport>>;
    readonly clear: Effect.Effect<void>;
    /** Follows the registry's environments and sends their reports until the scope closes. */
    readonly follow: (registry: FollowedRegistry) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/client-runtime/networkReports/service/NetworkReports") {}

function withoutExpired(
  reports: ReadonlyArray<StoredNetworkReport>,
  now: number,
): ReadonlyArray<StoredNetworkReport> {
  return reports.filter((report) => now - report.endedAt <= MAX_NETWORK_REPORT_AGE_MS);
}

function newestFirst(reports: ReadonlyArray<StoredNetworkReport>) {
  return [...reports].sort((left, right) => right.endedAt - left.endedAt);
}

export const make = Effect.gen(function* () {
  const platform = yield* NetworkReportsPlatform;
  const clock = yield* Clock.Clock;
  const recorded = yield* Queue.unbounded<NetworkReportRecord>();
  const collector = new NetworkReportCollector({
    now: () => clock.currentTimeMillisUnsafe(),
    report: (record) => Queue.offerUnsafe(recorded, record),
  });
  const loaded = Option.match(Option.flatMap(yield* platform.store.load, decodeDocument), {
    onNone: () => [],
    onSome: (decoded) => decoded.reports,
  });
  const reports = yield* SubscriptionRef.make<ReadonlyArray<StoredNetworkReport>>(
    newestFirst(withoutExpired(loaded, yield* Clock.currentTimeMillis)),
  );

  // Each save writes the latest reports, one at a time, so an older snapshot
  // can never land after a newer one.
  const saving = yield* Semaphore.make(1);
  const save = SubscriptionRef.get(reports).pipe(
    Effect.flatMap((current) =>
      platform.store.save(encodeDocument({ version: STORED_DOCUMENT_VERSION, reports: current })),
    ),
    saving.withPermit,
  );

  const add = Effect.fnUntraced(function* (record: NetworkReportRecord) {
    const now = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.update(reports, (current) => {
      const environmentReports = [
        { ...record, delivered: false },
        ...current.filter((report) => report.environmentId === record.environmentId),
      ].slice(0, MAX_STORED_REPORTS_PER_ENVIRONMENT);
      return newestFirst(
        withoutExpired(
          [
            ...current.filter((report) => report.environmentId !== record.environmentId),
            ...environmentReports,
          ],
          now,
        ),
      );
    });
    yield* save;
  });

  const clear = SubscriptionRef.set(reports, []).pipe(Effect.andThen(save));

  const forget = Effect.fnUntraced(function* (environmentId: EnvironmentId) {
    collector.removeEnvironment(environmentId);
    yield* SubscriptionRef.update(reports, (current) =>
      current.filter((report) => report.environmentId !== environmentId),
    );
    yield* save;
  });

  const deliver = Effect.fnUntraced(function* (
    registry: FollowedRegistry,
    environmentId: EnvironmentId,
  ) {
    const state = yield* registry.state(environmentId);
    if (state.phase !== "connected") return;
    const config = yield* registry.run(environmentId, EnvironmentRpc.getInitialServerConfig());
    if (config.environment.capabilities.networkReports !== true) return;
    for (;;) {
      // Oldest first, so a long backlog arrives in order.
      const pending = (yield* SubscriptionRef.get(reports))
        .filter((report) => report.environmentId === environmentId && !report.delivered)
        .toReversed()
        .slice(0, MAX_NETWORK_REPORTS_PER_REQUEST);
      if (pending.length === 0) return;
      const now = yield* Clock.currentTimeMillis;
      yield* registry.run(
        environmentId,
        EnvironmentRpc.request(WS_METHODS.serverReportNetworkConditions, {
          reports: pending.map((report) => ({
            ...report.metrics,
            endedAgoMs: Math.min(MAX_NETWORK_REPORT_AGE_MS, Math.max(0, now - report.endedAt)),
          })),
        }),
      );
      const sent = new Set(pending);
      yield* SubscriptionRef.update(reports, (current) =>
        current.map((report) => (sent.has(report) ? { ...report, delivered: true } : report)),
      );
      yield* save;
    }
  });

  const follow = Effect.fnUntraced(function* (registry: FollowedRegistry) {
    // One delivery at a time, so a report is never sent twice concurrently.
    // A failed send waits for the next connection or report.
    const deliveries = yield* Queue.unbounded<EnvironmentId>();
    yield* Queue.take(deliveries).pipe(
      Effect.flatMap((environmentId) =>
        deliver(registry, environmentId).pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("Could not send network reports.", { environmentId, cause }),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* Queue.take(recorded).pipe(
      Effect.flatMap((record) =>
        add(record).pipe(Effect.andThen(Queue.offer(deliveries, record.environmentId))),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const followers = yield* FiberMap.make<EnvironmentId>();
    let registered = new Set<EnvironmentId>();
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.runForEach((entries) =>
        Effect.gen(function* () {
          const next = new Set(entries.keys());
          for (const environmentId of registered) {
            if (next.has(environmentId)) continue;
            yield* FiberMap.remove(followers, environmentId);
            yield* forget(environmentId);
          }
          for (const environmentId of next) {
            if (registered.has(environmentId)) continue;
            yield* FiberMap.run(
              followers,
              environmentId,
              registry.stateChanges(environmentId).pipe(
                Stream.runForEach((state) =>
                  Effect.sync(() => collector.connectionState(environmentId, state)).pipe(
                    Effect.andThen(
                      state.phase === "connected"
                        ? Queue.offer(deliveries, environmentId)
                        : Effect.void,
                    ),
                  ),
                ),
                Effect.ignore,
              ),
            );
          }
          registered = next;
        }),
      ),
      Effect.forkScoped,
    );
    yield* platform.active.pipe(
      Stream.runForEach((active) => Effect.sync(() => collector.setActive(active))),
      Effect.forkScoped,
    );
    yield* platform.networkKind.pipe(
      Stream.runForEach((kind) => Effect.sync(() => collector.setNetworkKind(kind))),
      Effect.forkScoped,
    );
    yield* Stream.tick("1 minute").pipe(
      Stream.runForEach(() => Effect.sync(() => collector.tick())),
      Effect.forkScoped,
    );
  });

  const meters = NetworkMeters.of({
    forConnection: (connection) =>
      collector.meter(
        connection.environmentId,
        preparedConnectionRouteKind(connection),
        connectionRouteId(connection.target),
      ),
  });
  return Context.make(NetworkReports, NetworkReports.of({ reports, clear, follow })).pipe(
    Context.add(NetworkMeters, meters),
  );
});

export const layer = Layer.effectContext(make);
