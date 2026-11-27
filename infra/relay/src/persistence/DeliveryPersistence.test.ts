import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";

import { layerLocalRelayDb } from "../test/localRelayDb.ts";
import { apiPauseContract, deliveryAttemptContract } from "../test/deliveryPersistenceContract.ts";
import * as PostgresCloudflareApiPause from "./PostgresCloudflareApiPause.ts";
import * as PostgresDeliveryAttempts from "./PostgresDeliveryAttempts.ts";

const layer = Layer.mergeAll(PostgresDeliveryAttempts.layer, PostgresCloudflareApiPause.layer).pipe(
  Layer.provide(layerLocalRelayDb),
  Layer.provide(NodeCrypto.layer),
);

deliveryAttemptContract("Postgres delivery attempts", layer);
apiPauseContract("Postgres API pause", layer);
