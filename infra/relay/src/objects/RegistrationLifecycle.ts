import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { RelayConfiguration } from "../Config.ts";
import { ApnsDeliveryQueue } from "../agentActivity/ApnsDeliveryQueue.ts";
import { LiveActivityRegistrationsChanged } from "../agentActivity/LiveActivityCleanup.ts";
import { AuthSessionPersistenceError } from "../auth/AuthSessions.ts";
import type { IdentityCommand } from "./AccountIdentity.ts";
import { RegistrationCoordinator } from "./RegistrationCoordinator.ts";
import type { RegistrationBindings } from "./RegistrationCoordinator.ts";
import { RPC_VERSION as version } from "./storage.ts";

const isSessionError = Schema.is(AuthSessionPersistenceError);

export const registrationLifecycle = Effect.fn("relay.object_sessions.lifecycle")(function* (
  bindings: RegistrationBindings,
) {
  const queue = yield* ApnsDeliveryQueue;
  const config = yield* RelayConfiguration;
  const coordinator = new RegistrationCoordinator(bindings);
  return Effect.fn("relay.object_sessions.remove_registrations")(function* (
    userId: string,
    command: IdentityCommand,
  ) {
    const operation = command.kind === "prune-sessions" ? "prune-expired" : "revoke";
    const now = DateTime.formatIso(yield* DateTime.now);
    const attempt = Effect.gen(function* () {
      let removal = yield* Effect.tryPromise({
        try: () => coordinator.account(userId).registrationRemoval({ version, userId, command }),
        catch: (cause) => new AuthSessionPersistenceError({ operation, cause }),
      });
      if (removal.records.some((record) => record.pending)) {
        yield* Effect.tryPromise({
          try: async () => {
            for (const record of removal.records)
              if (record.pending) await coordinator.settle(userId, record.deviceId, now);
          },
          catch: (cause) => new AuthSessionPersistenceError({ operation, cause }),
        });
        removal = yield* Effect.tryPromise({
          try: () => coordinator.account(userId).registrationRemoval({ version, userId, command }),
          catch: (cause) => new AuthSessionPersistenceError({ operation, cause }),
        });
      }
      if (config.apns) {
        const targets = yield* Effect.tryPromise({
          try: async () =>
            (
              await Promise.all(
                removal.sessionIds.map((sessionId) =>
                  coordinator.cleanup({ kind: "session", userId, sessionId }, now),
                ),
              )
            ).flat(),
          catch: (cause) => new AuthSessionPersistenceError({ operation, cause }),
        });
        yield* Effect.forEach(
          targets,
          (target) =>
            queue.enqueueLiveActivity({
              ...target,
              kind: "live_activity_end",
              aggregate: null,
              registrationRemoved: true,
            }),
          { concurrency: 8, discard: true },
        );
      }
      const result = yield* Effect.tryPromise({
        try: async () =>
          await coordinator.account(userId).identity({
            version,
            userId,
            command,
            registrationGuard: { sessionIds: removal.sessionIds, stamp: removal.stamp },
          }),
        catch: (cause) => new AuthSessionPersistenceError({ operation, cause }),
      });
      if ("registrationsChanged" in result || "registrationPending" in result)
        return yield* new LiveActivityRegistrationsChanged({});
      if ("retirements" in result)
        yield* Effect.tryPromise({
          try: () => coordinator.drain(userId, result.retirements ?? [], now),
          catch: (cause) => new AuthSessionPersistenceError({ operation, cause }),
        });
      return result;
    });
    return yield* attempt.pipe(
      Effect.retry({ times: 2, while: Schema.is(LiveActivityRegistrationsChanged) }),
      Effect.mapError((cause) =>
        isSessionError(cause) ? cause : new AuthSessionPersistenceError({ operation, cause }),
      ),
    );
  });
});
