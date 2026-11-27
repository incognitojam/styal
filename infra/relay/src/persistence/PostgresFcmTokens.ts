import { and, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { FcmDeliveryError } from "../agentActivity/FcmDeliveries.ts";
import { FcmTokenPersistence } from "./DeliveryTargetPersistence.ts";
import { relayMobileDevices } from "./schema.ts";

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  return FcmTokenPersistence.of({
    // The consumer already owns the relay.fcm.process span.
    invalidate: Effect.fnUntraced(function* (input) {
      yield* db
        .update(relayMobileDevices)
        .set({ pushToken: null })
        .where(
          and(
            eq(relayMobileDevices.userId, input.userId),
            eq(relayMobileDevices.deviceId, input.deviceId),
            eq(relayMobileDevices.pushToken, input.token),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) => new FcmDeliveryError({ operation: "invalidate-token", cause }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(FcmTokenPersistence, make);
