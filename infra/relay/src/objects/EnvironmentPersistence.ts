import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Base64Url from "effect/encoding/Base64Url";
import { sha256 } from "@noble/hashes/sha256";
import { utf8ToBytes } from "@noble/hashes/utils";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import {
  AgentActivityPersistence,
  EnvironmentCredentialPersistence,
  EnvironmentLinkPersistence,
} from "../persistence/EnvironmentPersistence.ts";
import { EnvironmentLinkCompletionPersistence } from "../persistence/EnvironmentLinkCompletionPersistence.ts";
import {
  EnvironmentLinkUpsertPersistenceError,
  EnvironmentLinkListPersistenceError,
  EnvironmentLinkLookupPersistenceError,
  EnvironmentLinkEnvironmentLookupPersistenceError,
  EnvironmentLinkRevokePersistenceError,
  EnvironmentLinkUserListPersistenceError,
} from "../environments/EnvironmentLinks.ts";
import {
  EnvironmentCredentialCreatePersistenceError,
  EnvironmentCredentialAuthenticatePersistenceError,
  EnvironmentCredentialRevokePersistenceError,
} from "../environments/EnvironmentCredentials.ts";
import {
  AgentActivityRowUpsertPersistenceError,
  AgentActivityRowDeletePersistenceError,
  AgentActivityRowListPersistenceError,
  AgentActivityRowPruneTerminalPersistenceError,
} from "../agentActivity/AgentActivityRows.ts";
import { EnvironmentCoordinator, activeLink } from "./EnvironmentCoordinator.ts";
import type { EnvironmentBindings } from "./EnvironmentCoordinator.ts";
import type { LinkIntent, StoredLink } from "./AccountLinks.ts";
import { environmentName } from "./names.ts";
import { RPC_VERSION as version } from "./storage.ts";

const record = (l: StoredLink): RelayClientEnvironmentRecord => ({
  environmentId: l.environmentId as RelayClientEnvironmentRecord["environmentId"],
  label: l.label.trim().length ? l.label : l.environmentId,
  endpoint: l.endpoint,
  linkedAt: l.createdAt,
});
const intent = (
  input: Parameters<EnvironmentLinkPersistence["Service"]["upsert"]>[0],
): LinkIntent => ({
  userId: input.userId,
  environmentId: input.proof.environmentId,
  environmentPublicKey: input.proof.environmentPublicKey,
  label: input.proof.descriptor.label,
  endpoint: input.endpoint,
  notificationsEnabled: input.request.notificationsEnabled,
  liveActivitiesEnabled: input.request.liveActivitiesEnabled,
  managedTunnelsEnabled: input.request.managedTunnelsEnabled,
  createdByDeviceId: input.request.deviceId ?? null,
});
export const machineTokenHash = (token: string) => Base64Url.encode(sha256(utf8ToBytes(token)));
const call = <A, E>(body: () => Promise<A>, error: (cause: unknown) => E) =>
  Effect.tryPromise({ try: body, catch: error });

export function environmentLayer(bindings: EnvironmentBindings) {
  return Layer.effectContext(
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      const c = new EnvironmentCoordinator(bindings);
      const makeCredential = Effect.fn("relay.object_environment_credentials.prepare")(
        function* () {
          const parts = yield* Effect.all(Array.from({ length: 5 }, () => random.uuidV4()));
          const credentialId = parts.slice(0, 2).join("").replaceAll("-", "");
          const token = `t3env_${credentialId}_${parts.slice(2).join("").replaceAll("-", "")}`;
          return { credentialId, tokenHash: machineTokenHash(token), token };
        },
      );
      const links = EnvironmentLinkPersistence.of({
        upsert: Effect.fn("relay.object_environment_links.upsert")(function* (input) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const id = yield* random.uuidV4();
          yield* call(
            () => c.upsert(intent(input), id, now),
            (cause) =>
              new EnvironmentLinkUpsertPersistenceError({
                userId: input.userId,
                environmentId: input.proof.environmentId,
                ...(input.request.deviceId === undefined
                  ? {}
                  : { deviceId: input.request.deviceId }),
                cause,
              }),
          );
        }),
        getForUser: Effect.fn("relay.object_environment_links.get_for_user")((input) =>
          call(
            async () => {
              const l = await c.read(input.userId, input.environmentId);
              return activeLink(l)
                ? { ...record(l), environmentPublicKey: l.environmentPublicKey }
                : null;
            },
            (cause) => new EnvironmentLinkLookupPersistenceError({ ...input, cause }),
          ),
        ),
        listForUser: Effect.fn("relay.object_environment_links.list_for_user")((input) =>
          call(
            async () => (await c.list(input.userId)).filter(activeLink).map(record),
            (cause) => new EnvironmentLinkListPersistenceError({ ...input, cause }),
          ),
        ),
        listDeliveryUsersForEnvironment: Effect.fn("relay.object_environment_links.delivery_users")(
          (input) =>
            call(
              async () =>
                (await c.owners(input.environmentId, input.environmentPublicKey))
                  .filter((l) => l.notificationsEnabled || l.liveActivitiesEnabled)
                  .map((l) => ({
                    userId: l.userId,
                    notificationsEnabled: l.notificationsEnabled,
                    liveActivitiesEnabled: l.liveActivitiesEnabled,
                  })),
              (cause) =>
                new EnvironmentLinkUserListPersistenceError({
                  environmentId: input.environmentId,
                  cause,
                }),
            ),
        ),
        findActiveManagedForEnvironment: Effect.fn("relay.object_environment_links.find_managed")(
          (input) =>
            call(
              async () => {
                const all =
                  input.userId === undefined
                    ? await c.owners(input.environmentId, input.environmentPublicKey)
                    : [await c.read(input.userId, input.environmentId)].filter(activeLink);
                if (input.userId !== undefined && all[0]) {
                  const candidates = await c
                    .environment(input.environmentId)
                    .candidates({ version, environmentId: input.environmentId });
                  const current = candidates.find(
                    (candidate) =>
                      candidate.userId === input.userId &&
                      candidate.generation === all[0]!.generation,
                  );
                  if (current)
                    all[0] = {
                      ...all[0],
                      holdWebhooksWhileOffline: current.holdWebhooksWhileOffline,
                    };
                }
                return all
                  .filter(
                    (l) =>
                      l.managedTunnelsEnabled &&
                      l.endpoint.providerKind === "cloudflare_tunnel" &&
                      (input.environmentPublicKey === undefined ||
                        l.environmentPublicKey === input.environmentPublicKey),
                  )
                  .map((l) => ({
                    ...record(l),
                    environmentPublicKey: l.environmentPublicKey,
                    userId: l.userId,
                    holdWebhooksWhileOffline: l.holdWebhooksWhileOffline,
                  }));
              },
              (cause) =>
                new EnvironmentLinkEnvironmentLookupPersistenceError({
                  environmentId: input.environmentId,
                  cause,
                }),
            ),
        ),
        setHoldWebhooksWhileOffline: Effect.fn("relay.object_environment_links.set_hold")((input) =>
          call(
            async () => {
              const owners = await c.owners(input.environmentId, input.environmentPublicKey);
              await c.environment(input.environmentId).setHold({
                version,
                ...input,
                hold: input.holdWebhooksWhileOffline,
                members: owners.map((l) => ({ userId: l.userId, generation: l.generation })),
              });
            },
            (cause) =>
              new EnvironmentLinkEnvironmentLookupPersistenceError({
                environmentId: input.environmentId,
                cause,
              }),
          ),
        ),
        revokeForUser: Effect.fn("relay.object_environment_links.revoke")(function* (input) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const id = yield* random.uuidV4();
          return yield* call(
            () => c.revoke(input.userId, input.environmentId, id, now),
            (cause) => new EnvironmentLinkRevokePersistenceError({ ...input, cause }),
          );
        }),
      });
      const credentials = EnvironmentCredentialPersistence.of({
        create: Effect.fn("relay.object_environment_credentials.create")(function* (input) {
          const credential = yield* makeCredential().pipe(
            Effect.mapError(
              (cause) =>
                new EnvironmentCredentialCreatePersistenceError({
                  stage: "generate-credential",
                  ...input,
                  cause,
                }),
            ),
          );
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* call(
            () =>
              c.publishCredential(input.environmentId, {
                credentialId: credential.credentialId,
                tokenHash: credential.tokenHash,
                environmentPublicKey: input.environmentPublicKey,
                createdAt: now,
              }),
            (cause) =>
              new EnvironmentCredentialCreatePersistenceError({
                stage: "insert-credential",
                environmentId: input.environmentId,
                credentialId: credential.credentialId,
                cause,
              }),
          );
          return credential.token;
        }),
        authenticate: Effect.fn("relay.object_environment_credentials.authenticate")((token) =>
          call(
            async () => Option.fromNullishOr(await c.authenticate(machineTokenHash(token))),
            (cause) =>
              new EnvironmentCredentialAuthenticatePersistenceError({
                stage: "lookup-credential",
                cause,
              }),
          ),
        ),
        revokeForEnvironmentPublicKey: Effect.fn("relay.object_environment_credentials.revoke")(
          (input) =>
            call(
              () => c.environment(input.environmentId).revokeCredentials({ version, ...input }),
              (cause) =>
                new EnvironmentCredentialRevokePersistenceError({
                  environmentId: input.environmentId,
                  cause,
                }),
            ),
        ),
      });
      const rows = AgentActivityPersistence.of({
        upsert: Effect.fn("relay.object_activity.upsert")((input) =>
          call(
            async () => {
              const stub = c.environment(input.state.environmentId);
              const request = {
                version,
                environmentId: input.state.environmentId,
                command: { kind: "upsert" as const, ...input },
              };
              let result = await stub.activity(request);
              if (result.needsRegistration) {
                await c.register("environment", environmentName(input.state.environmentId));
                result = await stub.activity({ ...request, registered: true });
              }
              return result.previous;
            },
            (cause) =>
              new AgentActivityRowUpsertPersistenceError({
                environmentId: input.state.environmentId,
                threadId: input.state.threadId,
                cause,
              }),
          ),
        ),
        remove: Effect.fn("relay.object_activity.remove")((input) =>
          call(
            async () => {
              await c.environment(input.environmentId).activity({
                version,
                environmentId: input.environmentId,
                command: { kind: "remove", ...input },
              });
            },
            (cause) =>
              new AgentActivityRowDeletePersistenceError({
                environmentId: input.environmentId,
                threadId: input.threadId,
                cause,
              }),
          ),
        ),
        pruneTerminal: Effect.fn("relay.object_activity.prune")((input) =>
          call(
            () => c.prune(input.updatedBefore),
            (cause) => new AgentActivityRowPruneTerminalPersistenceError({ ...input, cause }),
          ),
        ),
        listForUser: Effect.fn("relay.object_activity.list")((input) =>
          call(
            async () => {
              const result = [];
              for (const l of (await c.list(input.userId)).filter(
                (l) => activeLink(l) && l.liveActivitiesEnabled,
              )) {
                const response = await c.environment(l.environmentId).activity({
                  version,
                  environmentId: l.environmentId,
                  command: { kind: "read", environmentPublicKey: l.environmentPublicKey },
                });
                const current = await c.read(l.userId, l.environmentId);
                if (
                  !activeLink(current) ||
                  current.generation !== l.generation ||
                  current.environmentPublicKey !== l.environmentPublicKey ||
                  !current.liveActivitiesEnabled
                )
                  throw new Error("Link changed while reading activity");
                result.push(...response.states);
              }
              return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            },
            (cause) => new AgentActivityRowListPersistenceError({ ...input, cause }),
          ),
        ),
        getForUserThread: Effect.fn("relay.object_activity.get")((input) =>
          call(
            async () => {
              const l = await c.read(input.userId, input.environmentId);
              if (!activeLink(l)) return null;
              const response = await c.environment(l.environmentId).activity({
                version,
                environmentId: l.environmentId,
                command: { kind: "read", environmentPublicKey: l.environmentPublicKey },
              });
              const current = await c.read(l.userId, l.environmentId);
              if (
                !activeLink(current) ||
                current.generation !== l.generation ||
                current.environmentPublicKey !== l.environmentPublicKey
              )
                return null;
              return response.states.find((s) => s.threadId === input.threadId) ?? null;
            },
            (cause) => new AgentActivityRowListPersistenceError({ userId: input.userId, cause }),
          ),
        ),
      });
      const completion = EnvironmentLinkCompletionPersistence.of({
        complete: Effect.fn("relay.object_environment_links.complete")(function* (input) {
          const credential = yield* makeCredential().pipe(
            Effect.mapError(
              (cause) =>
                new EnvironmentCredentialCreatePersistenceError({
                  stage: "generate-credential",
                  environmentId: input.proof.environmentId,
                  cause,
                }),
            ),
          );
          const now = DateTime.formatIso(yield* DateTime.now);
          const operationId = yield* random.uuidV4();
          const prepared = {
            ...intent(input),
            credential: { credentialId: credential.credentialId, tokenHash: credential.tokenHash },
          };
          const linkError = (cause: unknown) =>
            new EnvironmentLinkUpsertPersistenceError({
              userId: input.userId,
              environmentId: input.proof.environmentId,
              cause,
            });
          const link = yield* call(() => c.beginLink(prepared, operationId, now), linkError);
          yield* call(() => c.installCandidate(link), linkError);
          yield* call(
            () =>
              c.stageCredential(link.environmentId, {
                ...prepared.credential,
                environmentPublicKey: link.environmentPublicKey,
                createdAt: link.updatedAt,
                link: { userId: link.userId, generation: link.generation },
              }),
            (cause) =>
              new EnvironmentCredentialCreatePersistenceError({
                stage: "insert-credential",
                environmentId: link.environmentId,
                credentialId: credential.credentialId,
                cause,
              }),
          );
          yield* call(() => c.publishLink(link), linkError);
          yield* call(
            () => c.confirmCredential(link.environmentId, credential.tokenHash),
            (cause) =>
              new EnvironmentCredentialCreatePersistenceError({
                stage: "insert-credential",
                environmentId: link.environmentId,
                credentialId: credential.credentialId,
                cause,
              }),
          );
          return credential.token;
        }),
      });
      return Context.make(EnvironmentLinkPersistence, links).pipe(
        Context.add(EnvironmentCredentialPersistence, credentials),
        Context.add(AgentActivityPersistence, rows),
        Context.add(EnvironmentLinkCompletionPersistence, completion),
      );
    }),
  );
}
