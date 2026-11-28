import { and, eq, inArray, isNotNull } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relayLiveActivities, relayMobileDevices } from "./schema.ts";
import {
  RegistrationCleanupPersistence,
  type RegistrationCleanupScope,
} from "./DeliveryTargetPersistence.ts";

const conditionFor = (scope: RegistrationCleanupScope) => {
  switch (scope.kind) {
    case "account":
      return eq(relayMobileDevices.userId, scope.userId);
    case "session":
      return and(
        eq(relayMobileDevices.userId, scope.userId),
        eq(relayMobileDevices.sessionId, scope.sessionId),
      )!;
    case "sessions":
      return inArray(relayMobileDevices.sessionId, scope.sessionIds);
  }
};

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  return RegistrationCleanupPersistence.of({
    // Cleanup already owns the operation span; retain the original driver error unchanged.
    listTargets: Effect.fnUntraced(function* (scope) {
      return yield* db
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
        .where(and(conditionFor(scope), isNotNull(relayLiveActivities.activityPushToken)));
    }),
  });
});

export const layer = Layer.effect(RegistrationCleanupPersistence, make);
