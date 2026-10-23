import { and, eq, isNotNull, type SQL } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import * as RelayConfiguration from "../Config.ts";
import { relayLiveActivities, relayMobileDevices } from "../persistence/schema.ts";
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
  const db = yield* RelayDb.RelayDb;
  const queue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
  const config = yield* RelayConfiguration.RelayConfiguration;

  const listTargets = (condition: SQL) =>
    db
      .select({
        userId: relayLiveActivities.userId,
        deviceId: relayLiveActivities.deviceId,
        token: relayLiveActivities.activityPushToken,
        bundleId: relayMobileDevices.bundleId,
        apsEnvironment: relayMobileDevices.apsEnvironment,
      })
      .from(relayMobileDevices)
      .innerJoin(
        relayLiveActivities,
        and(
          eq(relayMobileDevices.userId, relayLiveActivities.userId),
          eq(relayMobileDevices.deviceId, relayLiveActivities.deviceId),
        ),
      )
      .where(and(condition, isNotNull(relayLiveActivities.activityPushToken)));

  const enqueueEnds = Effect.fn("relay.live_activity_cleanup.enqueue_ends")(function* (
    condition: SQL,
  ) {
    const targets = yield* listTargets(condition);
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
   * Removes the mobile registrations matched by `condition` (a predicate on
   * relay_mobile_devices) once their Live Activities have end jobs queued.
   *
   * The queue sends run before `remove` opens its transaction, so a slow
   * queue holds no row locks. A queue failure fails the removal before
   * anything is deleted, keeping the tokens for a retry. `remove` must yield
   * `confirm` inside its transaction after taking the locks that stop new
   * registrations (the session rows) and before deleting registrations.
   * `confirm` fails when a matching registration arrived after the sends,
   * which rolls the transaction back and runs the whole removal again.
   * Duplicate end jobs are safe: an APNs token identifies one card.
   */
  const removeAfterEnds = <A, E, R>(
    condition: SQL,
    remove: (
      confirm: Effect.Effect<void, LiveActivityRegistrationsChanged | EffectDrizzleQueryError>,
    ) => Effect.Effect<A, E, R>,
  ) => {
    if (!config.apns) return remove(Effect.void);
    return Effect.gen(function* () {
      const queued = yield* enqueueEnds(condition);
      const confirm = Effect.gen(function* () {
        const current = yield* listTargets(condition);
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
