import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";

import * as RelayConfiguration from "../Config.ts";
import { config } from "../test/fixtures.ts";
import { layerLocalRelayDb } from "../test/localRelayDb.ts";
import { registrationPersistenceContract } from "../test/registrationPersistenceContract.ts";
import * as PostgresAccounts from "./PostgresAccounts.ts";
import * as PostgresAuthSessions from "./PostgresAuthSessions.ts";
import * as PostgresDevices from "./PostgresDevices.ts";
import * as PostgresLiveActivities from "./PostgresLiveActivities.ts";

const layer = Layer.mergeAll(
  PostgresDevices.layer,
  PostgresLiveActivities.layer,
  PostgresAccounts.layer,
  PostgresAuthSessions.layer,
).pipe(
  Layer.provide(RelayConfiguration.layer(config)),
  Layer.provide(layerLocalRelayDb),
  Layer.provide(NodeCrypto.layer),
);

registrationPersistenceContract("Postgres registration persistence", layer);
