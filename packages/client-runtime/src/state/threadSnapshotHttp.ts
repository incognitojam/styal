import {
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/reactivity";
import { createEnvironmentCommand } from "./runtime.ts";
import * as EnvironmentRpc from "../rpc/client.ts";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { layerRemoteHttpClient, type RemoteEnvironmentRequestError } from "../rpc/http.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";

// Long enough for a slow but alive server to finish. On a cold open a timeout makes the socket
// ask the same server for the same snapshot again, and older turn pages have no fallback, so a
// short deadline only drops work. The socket fallback is for setups where /api fails but /ws
// works, such as a proxy that blocks /api.
const DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS = 20_000;

/** Full reads are independent of the bounded loader used by the active timeline. */
export function createThreadSnapshotCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    fetchFull: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:fetch-full-snapshot",
      execute: Effect.fn("threadSnapshot.fetchFull")(function* (input: {
        readonly threadId: ThreadId;
      }) {
        const supervisor = yield* EnvironmentSupervisor;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared)) return Option.none<OrchestrationV2ThreadProjection>();
        const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
        const remoteAuthorization = yield* Effect.serviceOption(
          RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
        );
        const snapshot = yield* fetchEnvironmentThreadSnapshot({
          prepared: prepared.value,
          threadId: input.threadId,
          signer,
          remoteAuthorization,
        }).pipe(Effect.provide(layerRemoteHttpClient(globalThis.fetch)), Effect.option);
        if (Option.isSome(snapshot)) return Option.some(snapshot.value.projection);
        return Option.some(
          yield* EnvironmentRpc.request(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
            threadId: input.threadId,
          }),
        );
      }),
    }),
  };
}

export type ThreadSnapshotHistoryMeta = {
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  readonly latestLocalTurnOrdinal?: number | null;
};

export type ThreadSnapshotLoadResult =
  | {
      readonly _tag: "present";
      readonly snapshot: OrchestrationV2ThreadDetailSnapshot;
      readonly history?: ThreadSnapshotHistoryMeta;
    }
  | { readonly _tag: "missing" }
  | { readonly _tag: "unavailable" };

export const fetchEnvironmentThreadSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
  readonly timeoutMs?: number;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (urls) => urls.threadSnapshot({ params: { threadId: input.threadId } }),
    timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.threadSnapshot({
        params: { threadId: input.threadId },
        headers: withOrchestrationProtocolHeader(headers),
      }),
  });
});

export type FetchEnvironmentThreadSnapshotError = RemoteEnvironmentRequestError;

export class ThreadSnapshotLoader extends Context.Service<
  ThreadSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
    ) => Effect.Effect<ThreadSnapshotLoadResult>;
  }
>()("@t3tools/client-runtime/state/threadSnapshotHttp/ThreadSnapshotLoader") {}
