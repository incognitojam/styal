import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
} from "@t3tools/contracts/relay";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { ConnectionBlockedError } from "../connection/model.ts";
import { findErrorTraceId } from "../errors/errorTrace.ts";
import * as ManagedRelay from "./managedRelay.ts";
import { relayProtectedErrorMessage } from "./errorPresentation.ts";

const DEFAULT_STALE_TIME_MS = 15_000;
const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
const isManagedRelayRequestFailedError = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);

export interface ManagedRelaySession {
  readonly accountId: string;
  /** Null for accounts moved from Clerk whose email the relay does not know. */
  readonly email: string | null;
  readonly credential: ManagedRelay.ManagedRelayCredential;
}

export interface ManagedRelaySnapshotState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly errorTraceId: string | null;
  readonly isPending: boolean;
}

export interface ManagedRelayQueryEvent {
  readonly operation: "environments" | "devices" | "environment-status";
  readonly stage: "session" | "relay-request" | "validation";
  readonly phase: "start" | "success" | "failure";
  readonly accountId: string;
  readonly environmentId?: string;
  readonly message?: string;
  readonly traceId?: string | null;
}

export class ManagedRelaySessionError extends Data.TaggedError("ManagedRelaySessionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ManagedRelaySnapshotError extends Data.TaggedError("ManagedRelaySnapshotError")<{
  readonly message: string;
}> {}

export const managedRelaySessionAtom = Atom.make<ManagedRelaySession | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("managed-relay:session"),
);

/**
 * Progress of loading the saved sign-in. Until it loads there is no session
 * either way, so this tells "still loading" and "unreadable" apart from signed out.
 */
export type ManagedRelayAuthLoadState = "loading" | "failed" | "loaded";

export const managedRelayAuthLoadAtom = Atom.make<ManagedRelayAuthLoadState>("loading").pipe(
  Atom.keepAlive,
  Atom.withLabel("managed-relay:auth-load"),
);

/** The connection error for a styal Link environment while there is no cloud session. */
export function managedRelayMissingSessionError(
  loadState: ManagedRelayAuthLoadState,
): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "authentication",
    detail:
      loadState === "loading"
        ? "Waiting for the styal Link sign-in to load."
        : loadState === "failed"
          ? "Couldn't read the saved styal Link sign-in. Try again, or sign in again."
          : "Sign in to styal Link to connect this environment.",
  });
}

/**
 * Publishes the signed-in session, or null when signed out. Setting the same
 * account and credential again keeps the current object, so queries and
 * connection leases keyed on it are not reset.
 */
export function setManagedRelaySession(
  registry: AtomRegistry.AtomRegistry,
  input: ManagedRelaySession | null,
): void {
  const current = registry.get(managedRelaySessionAtom);
  if (input === null) {
    if (current !== null) {
      registry.set(managedRelaySessionAtom, null);
    }
    return;
  }
  if (
    current?.accountId === input.accountId &&
    current.credential.refreshToken === input.credential.refreshToken &&
    current.email === input.email
  ) {
    return;
  }
  registry.set(managedRelaySessionAtom, {
    accountId: input.accountId,
    email: input.email,
    credential: input.credential,
  });
}

export function managedRelayAccountChanges(
  registry: AtomRegistry.AtomRegistry,
): Stream.Stream<string | null> {
  return AtomRegistry.toStream(registry, managedRelaySessionAtom).pipe(
    Stream.map((session) => session?.accountId ?? null),
    Stream.changes,
    Stream.drop(1),
  );
}

/** Emits when the sign-in SDK settles or fails, so blocked connections re-report why. */
export function managedRelayAuthLoadChanges(
  registry: AtomRegistry.AtomRegistry,
): Stream.Stream<ManagedRelayAuthLoadState> {
  return AtomRegistry.toStream(registry, managedRelayAuthLoadAtom).pipe(
    Stream.changes,
    Stream.drop(1),
  );
}

/** Removes an environment from the signed-in account without contacting that environment. */
export const deregisterManagedRelayEnvironment = Effect.fn(
  "clientRuntime.managedRelaySession.deregisterEnvironment",
)(function* (
  registry: AtomRegistry.AtomRegistry,
  input: { readonly accountId: string; readonly environmentId: EnvironmentId },
) {
  const session = registry.get(managedRelaySessionAtom);
  if (!session || session.accountId !== input.accountId) {
    return yield* new ManagedRelaySessionError({
      message: "Sign in to styal Link before deregistering an environment.",
    });
  }
  const relay = yield* ManagedRelay.ManagedRelayClient;
  yield* relay.unlinkEnvironment({
    credential: session.credential,
    environmentId: input.environmentId,
  });
});

function requireCredential(
  get: Atom.AtomContext,
  accountId: string,
): Effect.Effect<ManagedRelay.ManagedRelayCredential, ManagedRelaySessionError> {
  const session = get(managedRelaySessionAtom);
  if (!session || session.accountId !== accountId) {
    return Effect.fail(
      new ManagedRelaySessionError({
        message: "Sign in to styal Link before loading relay data.",
      }),
    );
  }
  return Effect.succeed(session.credential);
}

function statusKey(input: {
  readonly accountId: string;
  readonly environment: RelayClientEnvironmentRecord;
}): string {
  return JSON.stringify(input);
}

function parseStatusKey(key: string): {
  readonly accountId: string;
  readonly environment: RelayClientEnvironmentRecord;
} {
  return JSON.parse(key) as {
    readonly accountId: string;
    readonly environment: RelayClientEnvironmentRecord;
  };
}

function endpointMatches(
  left: RelayClientEnvironmentRecord["endpoint"],
  right: RelayClientEnvironmentRecord["endpoint"],
): boolean {
  return (
    left.httpBaseUrl === right.httpBaseUrl &&
    left.wsBaseUrl === right.wsBaseUrl &&
    left.providerKind === right.providerKind
  );
}

function validateEnvironmentStatus(
  environment: RelayClientEnvironmentRecord,
  status: RelayEnvironmentStatusResponse,
): Effect.Effect<RelayEnvironmentStatusResponse, ManagedRelaySnapshotError> {
  if (status.environmentId !== environment.environmentId) {
    return Effect.fail(
      new ManagedRelaySnapshotError({
        message: "Relay returned status for a different environment.",
      }),
    );
  }
  if (!endpointMatches(status.endpoint, environment.endpoint)) {
    return Effect.fail(
      new ManagedRelaySnapshotError({
        message: "Relay returned status for a different endpoint.",
      }),
    );
  }
  if (status.descriptor && status.descriptor.environmentId !== environment.environmentId) {
    return Effect.fail(
      new ManagedRelaySnapshotError({
        message: "Relay returned status descriptor for a different environment.",
      }),
    );
  }
  return Effect.succeed(status);
}

export function readManagedRelaySnapshotState<A>(
  result: AsyncResult.AsyncResult<A, unknown>,
): ManagedRelaySnapshotState<A> {
  let error: string | null = null;
  let errorTraceId: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error =
      isManagedRelayRequestFailedError(cause) && cause.relayError
        ? relayProtectedErrorMessage(cause.relayError)
        : cause instanceof Error
          ? cause.message
          : "Could not load styal Link data.";
    errorTraceId = findErrorTraceId(cause);
  }
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error,
    errorTraceId,
    isPending: result.waiting,
  };
}

export function createManagedRelayQueryManager(
  runtime: Atom.AtomRuntime<ManagedRelay.ManagedRelayClient>,
  options?: {
    readonly staleTimeMs?: number;
    readonly idleTtlMs?: number;
    readonly onQueryEvent?: (event: ManagedRelayQueryEvent) => void;
  },
) {
  const staleTime = options?.staleTimeMs ?? DEFAULT_STALE_TIME_MS;
  const idleTtl = options?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const observe = <A, E, R>(
    input: Omit<ManagedRelayQueryEvent, "phase" | "message" | "traceId">,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      options?.onQueryEvent?.({ ...input, phase: "start" });
      return yield* effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (exit._tag === "Success") {
              options?.onQueryEvent?.({ ...input, phase: "success" });
              return;
            }
            const error = Cause.squash(exit.cause);
            options?.onQueryEvent?.({
              ...input,
              phase: "failure",
              message: error instanceof Error ? error.message : String(error),
              traceId: findErrorTraceId(error),
            });
          }),
        ),
      );
    });

  const environmentsAtom = Atom.family((accountId: string) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const base = { operation: "environments" as const, accountId };
          const credential = yield* observe(
            { ...base, stage: "session" },
            requireCredential(get, accountId),
          );
          const relay = yield* ManagedRelay.ManagedRelayClient;
          return yield* observe(
            { ...base, stage: "relay-request" },
            relay.listEnvironments({ credential }),
          );
        }),
      )
      .pipe(
        Atom.swr({ staleTime, revalidateOnMount: true }),
        Atom.setIdleTTL(idleTtl),
        Atom.withLabel(`managed-relay:environments:${accountId}`),
      ),
  );

  const devicesAtom = Atom.family((accountId: string) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const base = { operation: "devices" as const, accountId };
          const credential = yield* observe(
            { ...base, stage: "session" },
            requireCredential(get, accountId),
          );
          const relay = yield* ManagedRelay.ManagedRelayClient;
          return yield* observe(
            { ...base, stage: "relay-request" },
            relay.listDevices({ credential }),
          );
        }),
      )
      .pipe(
        Atom.swr({ staleTime, revalidateOnMount: true }),
        Atom.setIdleTTL(idleTtl),
        Atom.withLabel(`managed-relay:devices:${accountId}`),
      ),
  );

  const environmentStatusAtom = Atom.family((key: string) => {
    const { accountId, environment } = parseStatusKey(key);
    return runtime
      .atom((get) =>
        Effect.gen(function* () {
          const base = {
            operation: "environment-status" as const,
            accountId,
            environmentId: environment.environmentId,
          };
          const credential = yield* observe(
            { ...base, stage: "session" },
            requireCredential(get, accountId),
          );
          const relay = yield* ManagedRelay.ManagedRelayClient;
          const status = yield* observe(
            { ...base, stage: "relay-request" },
            relay.getEnvironmentStatus({
              credential,
              scopes: [RelayEnvironmentStatusScope, RelayEnvironmentConnectScope],
              environmentId: environment.environmentId,
            }),
          );
          return yield* observe(
            { ...base, stage: "validation" },
            validateEnvironmentStatus(environment, status),
          );
        }),
      )
      .pipe(
        Atom.swr({ staleTime, revalidateOnMount: true }),
        Atom.setIdleTTL(idleTtl),
        Atom.withLabel(`managed-relay:environment-status:${key}`),
      );
  });

  return {
    environmentsAtom,
    devicesAtom,
    environmentStatusAtom: (input: {
      readonly accountId: string;
      readonly environment: RelayClientEnvironmentRecord;
    }) => environmentStatusAtom(statusKey(input)),
    refreshEnvironments(registry: AtomRegistry.AtomRegistry, accountId: string): void {
      registry.refresh(environmentsAtom(accountId));
    },
    refreshDevices(registry: AtomRegistry.AtomRegistry, accountId: string): void {
      registry.refresh(devicesAtom(accountId));
    },
    refreshEnvironmentStatus(
      registry: AtomRegistry.AtomRegistry,
      input: {
        readonly accountId: string;
        readonly environment: RelayClientEnvironmentRecord;
      },
    ): void {
      registry.refresh(environmentStatusAtom(statusKey(input)));
    },
  };
}
