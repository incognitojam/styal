import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  RegistrationCleanupPersistence,
  type RegistrationCleanupReadError,
  type RegistrationCleanupScope,
} from "../persistence/DeliveryTargetPersistence.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";

/** A Live Activity registration matching the removal arrived after its end jobs were queued. */
export class LiveActivityRegistrationsChanged extends Schema.TaggedError<LiveActivityRegistrationsChanged>()(
  "LiveActivityRegistrationsChanged",
  {},
) {
  override get message(): string {
    return "Live Activity registrations changed while their end jobs were queued";
  }
}

/** Removal attempts before giving up when registrations keep arriving. */
const REMOVAL_ATTEMPTS = 3;
const SEND_CONCURRENCY = 8;

export const make = Effect.gen(function* () {
  const persistence = yield* RegistrationCleanupPersistence;
  const queue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
  const config = yield* RelayConfiguration.RelayConfiguration;

  const enqueueEnds = Effect.fn("relay.live_activity_cleanup.enqueue_ends")(function* (
    scope: RegistrationCleanupScope,
  ) {
    const targets = yield* persistence.listTargets(scope);
    yield* Effect.annotateCurrentSpan({ "relay.live_activity_cleanup.targets": targets.length });
    yield* Effect.forEach(
      targets,
      (target) =>
        target.token === null
          ? Effect.void
          : queue.enqueueLiveActivity({
              ...target,
              token: target.token,
              kind: "live_activity_end",
              aggregate: null,
              registrationRemoved: true,
            }),
      { concurrency: SEND_CONCURRENCY, discard: true },
    );
    return new Set(targets.flatMap((target) => (target.token === null ? [] : [target.token])));
  });

  /**
   * Queues Live Activity ends, then lets `remove` delete the matching relay_mobile_devices rows.
   * `remove` must yield `confirm` in its transaction after locking the session rows; `confirm`
   * fails if a registration arrived after the sends, rerunning the removal. Duplicate ends are safe.
   */
  const removeAfterEnds = <A, E, R>(
    scope: RegistrationCleanupScope,
    remove: (
      confirm: Effect.Effect<
        void,
        LiveActivityRegistrationsChanged | RegistrationCleanupReadError | EffectDrizzleQueryError
      >,
    ) => Effect.Effect<A, E, R>,
  ) => {
    if (!config.apns) return remove(Effect.void);
    return Effect.gen(function* () {
      const queued = yield* enqueueEnds(scope);
      const confirm = Effect.gen(function* () {
        const current = yield* persistence.listTargets(scope);
        if (current.some((target) => target.token !== null && !queued.has(target.token))) {
          return yield* new LiveActivityRegistrationsChanged({});
        }
      });
      return yield* remove(confirm);
    }).pipe(
      Effect.retry({
        times: REMOVAL_ATTEMPTS - 1,
        while: Schema.is(LiveActivityRegistrationsChanged),
      }),
    );
  };

  return { removeAfterEnds };
});
