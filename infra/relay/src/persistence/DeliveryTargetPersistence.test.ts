import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ApnsDeliveryQueue from "../agentActivity/ApnsDeliveryQueue.ts";
import * as RelayConfiguration from "../Config.ts";
import { config } from "../test/fixtures.ts";
import { layerLocalRelayDb } from "../test/localRelayDb.ts";
import { deliveryTargetPersistenceContract } from "../test/deliveryTargetPersistenceContract.ts";
import * as PostgresAccounts from "./PostgresAccounts.ts";
import * as PostgresAuthSessions from "./PostgresAuthSessions.ts";
import * as PostgresDevices from "./PostgresDevices.ts";
import * as PostgresLiveActivities from "./PostgresLiveActivities.ts";
import * as PostgresFcmTokens from "./PostgresFcmTokens.ts";
import * as PostgresRegistrationCleanup from "./PostgresRegistrationCleanup.ts";

const layer = Layer.mergeAll(
  PostgresAccounts.layer,
  PostgresDevices.layer,
  PostgresLiveActivities.layer,
  PostgresFcmTokens.layer,
  PostgresAuthSessions.layer.pipe(Layer.provide(PostgresRegistrationCleanup.layer)),
  PostgresRegistrationCleanup.layer,
).pipe(
  Layer.provide(
    Layer.mock(ApnsDeliveryQueue.ApnsDeliveryQueue, {
      enqueueLiveActivity: () => Effect.die("Unexpected cleanup enqueue"),
    }),
  ),
  Layer.provide(RelayConfiguration.layer(config)),
  Layer.provide(layerLocalRelayDb),
  Layer.provide(NodeCrypto.layer),
);

deliveryTargetPersistenceContract("Postgres delivery target persistence", layer);
