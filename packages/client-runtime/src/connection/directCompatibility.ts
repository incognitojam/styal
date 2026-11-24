import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";

import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";
import * as Connectivity from "./connectivity.ts";
import { ApplicationPresence } from "./presence.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { hasSavedBearerRoute, routeHttpBaseUrl, usableRoutes } from "./routes.ts";
import { retryDelayMs } from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";

// Relay discovery already rechecks machines reached only through styal Link.
const rechecked = (entry: ConnectionCatalogEntry) =>
  entry.enabled && entry.unsupportedReason !== undefined && hasSavedBearerRoute(entry);

/**
 * Nothing connects to a machine blocked for its version, so nothing would notice it update. While
 * the app is in front and online, its public descriptor is read again on the reconnect cadence
 * and on each wakeup, and the fresh verdict replaces the stored one.
 */
export const watchDirectCompatibility = Effect.fn("connection.watchDirectCompatibility")(
  function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
    const connectivity = yield* Connectivity.Connectivity;
    const presence = yield* ApplicationPresence;
    const httpClient = yield* HttpClient.HttpClient;
    const foreground = yield* Ref.make((yield* presence.current) === "foreground");
    const online = yield* Ref.make((yield* connectivity.status) !== "offline");
    const restarts = yield* Ref.make(0);

    const recheck = (entry: ConnectionCatalogEntry) => {
      const environmentId = entry.target.environmentId;
      // An address now answered by another machine loses its race, so the right one can win.
      const descriptors = usableRoutes(entry).flatMap((route) => {
        const httpBaseUrl = routeHttpBaseUrl(route);
        return httpBaseUrl === null
          ? []
          : [
              fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
                Effect.filterOrFail(
                  (descriptor) => descriptor.environmentId === environmentId,
                  () => "another-machine" as const,
                ),
              ),
            ];
      });
      if (descriptors.length === 0) return Effect.void;
      return Effect.raceAll(descriptors).pipe(
        Effect.flatMap((descriptor) =>
          registry.setCompatibility(
            environmentId,
            orchestrationProtocolCompatibilityError(descriptor),
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.ignore,
      );
    };

    const sweepEvery = Effect.fnUntraced(function* () {
      for (let sweep = 0; ; sweep += 1) {
        const entries = yield* SubscriptionRef.get(registry.entries);
        yield* Effect.forEach([...entries.values()].filter(rechecked), recheck, {
          concurrency: "unbounded",
          discard: true,
        });
        yield* Effect.sleep(retryDelayMs(sweep, yield* Random.next));
      }
    });

    // A restart interrupts the sweep in flight; a wakeup restarts it even when nothing else changed.
    const restart = { wake: true } as const;
    const settle = { wake: false } as const;
    yield* Stream.mergeAll(
      [
        Stream.succeed(restart),
        SubscriptionRef.changes(registry.entries).pipe(Stream.as(settle)),
        wakeups.changes.pipe(Stream.as(restart)),
        presence.changes.pipe(
          Stream.mapEffect((state) =>
            Ref.set(foreground, state === "foreground").pipe(
              Effect.as(state === "foreground" ? restart : settle),
            ),
          ),
        ),
        connectivity.changes.pipe(
          Stream.mapEffect((status) =>
            Ref.set(online, status !== "offline").pipe(Effect.as(settle)),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.mapEffect(({ wake }) =>
        Effect.gen(function* () {
          if (wake) yield* Ref.update(restarts, (count) => count + 1);
          const active = (yield* Ref.get(foreground)) && (yield* Ref.get(online));
          const entries = yield* SubscriptionRef.get(registry.entries);
          const blocked = active
            ? [...entries.values()]
                .filter(rechecked)
                .map((entry) => entry.target.environmentId)
                .sort()
                .join(",")
            : "";
          // Each restart gets its own key, so only an unchanged state without one is dropped.
          return blocked === "" ? "" : `${blocked}#${yield* Ref.get(restarts)}`;
        }),
      ),
      Stream.changes,
      Stream.switchMap((key) => (key === "" ? Stream.empty : Stream.fromEffect(sweepEvery()))),
      Stream.runDrain,
    );
  },
);
