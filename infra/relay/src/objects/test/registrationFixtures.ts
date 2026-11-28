import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Config from "../../Config.ts";
import { ApnsDeliveryQueue } from "../../agentActivity/ApnsDeliveryQueue.ts";
import { config } from "../../test/fixtures.ts";
export const disabledRegistrationCleanup = Layer.mergeAll(
  Config.layer({ ...config, apns: null }),
  Layer.succeed(
    ApnsDeliveryQueue,
    ApnsDeliveryQueue.of({
      enqueueLiveActivity: () =>
        Effect.die("Unexpected registration cleanup send with APNs disabled"),
      enqueuePushNotification: () => Effect.die("Unexpected notification with APNs disabled"),
    }),
  ),
);
