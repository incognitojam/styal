import type { EnvironmentId as EnvironmentIdType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Socket from "effect/socket/Socket";
import { AsyncResult, Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { retireLegacyPairing as retireLegacyPairingEffect } from "../connection/legacyPairing.ts";
import { AVAILABLE_CONNECTION_STATE, type PreparedConnection } from "../connection/model.ts";
import type * as ConnectionResolver from "../connection/resolver.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  PullRequestRoutingPermissions,
  type PullRequestRoutingPermission,
  type StoredPullRequestRoutingPermission,
} from "../connection/pullRequestRoutingPermissions.ts";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
  followStreamInEnvironment,
} from "./runtime.ts";

export interface EnvironmentCatalogState {
  readonly isReady: boolean;
  readonly entries: ReadonlyMap<EnvironmentIdType, ConnectionCatalogEntry>;
}

export function* enabledEnvironmentIds(
  catalog: EnvironmentCatalogState,
): Generator<EnvironmentIdType> {
  for (const [environmentId, entry] of catalog.entries) {
    if (entry.enabled && entry.unsupportedReason === undefined) {
      yield environmentId;
    }
  }
}

const EMPTY_ENVIRONMENT_CATALOG_STATE: EnvironmentCatalogState = Object.freeze({
  isReady: false,
  entries: new Map(),
});

export function createEnvironmentCatalogAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    | EnvironmentRegistry.EnvironmentRegistry
    | ConnectionResolver.ConnectionResolver
    | Socket.WebSocketConstructor
    | R,
    E
  >,
) {
  const commandScheduler = createAtomCommandScheduler();
  const serial = { mode: "serial" as const, key: () => "environment-catalog" };
  const catalogAtom = runtime.atom(
    Stream.unwrap(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.map((registry) =>
          SubscriptionRef.changes(registry.entries).pipe(
            Stream.map((entries) => ({
              isReady: true,
              entries,
            })),
          ),
        ),
      ),
    ),
    { initialValue: EMPTY_ENVIRONMENT_CATALOG_STATE },
  );

  const catalogValueAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(catalogAtom)), () => EMPTY_ENVIRONMENT_CATALOG_STATE),
  ).pipe(Atom.withLabel("environment-catalog-value"));

  const pullRequestRoutingPermissionsAtom = runtime.atom(
    Stream.unwrap(
      PullRequestRoutingPermissions.pipe(Effect.map((permissions) => permissions.changes)),
    ),
    { initialValue: [] as ReadonlyArray<StoredPullRequestRoutingPermission> },
  );
  const pullRequestRoutingPermissionsValueAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(pullRequestRoutingPermissionsAtom)), () => []),
  ).pipe(Atom.withLabel("environment-pull-request-routing-permissions"));
  const setPullRequestRoutingPermission = createRuntimeCommand(runtime, {
    label: "environment-catalog:pull-request-routing-permission",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: Effect.fn(function* (input: {
      readonly environmentId: EnvironmentIdType;
      readonly permission: PullRequestRoutingPermission;
    }) {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const entry = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
      if (entry === undefined)
        return yield* new EnvironmentRegistry.EnvironmentNotRegisteredError({
          environmentId: input.environmentId,
        });
      const permissions = yield* PullRequestRoutingPermissions;
      yield* permissions.set(entry, input.permission);
    }),
  });

  const networkStatusAtom = runtime.atom(
    Stream.unwrap(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.map((registry) => SubscriptionRef.changes(registry.networkStatus)),
      ),
    ),
    { initialValue: "unknown" as const },
  );

  const networkStatusValueAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(networkStatusAtom)), () => "unknown" as const),
  ).pipe(Atom.withLabel("environment-network-status-value"));

  const stateAtom = Atom.family((environmentId: EnvironmentIdType) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
          ),
        ),
      ),
      { initialValue: AVAILABLE_CONNECTION_STATE },
    ),
  );

  const register = createRuntimeCommand(runtime, {
    label: "environment-catalog:register",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (
      target: Parameters<EnvironmentRegistry.EnvironmentRegistry["Service"]["register"]>[0],
    ) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.register(target)),
      ),
  });
  const remove = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.remove(environmentId)),
      ),
  });
  const removeRelayEnvironments = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove-relay-environments",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (_input: void) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.removeRelayEnvironments()),
      ),
  });
  const setEnabled = createRuntimeCommand(runtime, {
    label: "environment-catalog:set-enabled",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: { readonly environmentId: EnvironmentIdType; readonly enabled: boolean }) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.setEnabled(input.environmentId, input.enabled)),
      ),
  });
  const removeRoute = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove-route",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: { readonly environmentId: EnvironmentIdType; readonly routeId: string }) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.removeRoute(input.environmentId, input.routeId)),
      ),
  });
  const retireLegacyPairing = createRuntimeCommand(runtime, {
    label: "environment-catalog:retire-legacy-pairing",
    scheduler: commandScheduler,
    // Connecting through T3 Connect first can take seconds, so this does not
    // hold up the other catalog commands; the registry lock covers the change.
    // Checks queued behind a running one collapse to the newest connection.
    concurrency: {
      mode: "latest",
      key: (input: { readonly environmentId: EnvironmentIdType }) =>
        `retire-legacy-pairing:${input.environmentId}`,
    },
    execute: (input: {
      readonly environmentId: EnvironmentIdType;
      readonly checked: PreparedConnection;
    }) => retireLegacyPairingEffect(input.environmentId, input.checked),
  });
  const reorderRoutes = createRuntimeCommand(runtime, {
    label: "environment-catalog:reorder-routes",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: {
      readonly environmentId: EnvironmentIdType;
      readonly routeIds: ReadonlyArray<string>;
    }) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.reorderRoutes(input.environmentId, input.routeIds)),
      ),
  });
  const retryNow = createRuntimeCommand(runtime, {
    label: "environment-catalog:retry-now",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.retryNow(environmentId)),
      ),
  });

  return {
    catalogAtom,
    catalogValueAtom,
    pullRequestRoutingPermissionsValueAtom,
    setPullRequestRoutingPermission,
    networkStatusAtom,
    networkStatusValueAtom,
    stateAtom,
    register,
    remove,
    removeRoute,
    retireLegacyPairing,
    reorderRoutes,
    removeRelayEnvironments,
    retryNow,
    setEnabled,
  };
}
