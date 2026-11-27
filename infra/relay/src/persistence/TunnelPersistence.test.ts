import * as PostgresEnvironmentLinks from "./PostgresEnvironmentLinks.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";
import { layerLocalRelayDb } from "../test/localRelayDb.ts";
import {
  managedEndpointAllocationContract,
  managedTunnelLimitContract,
} from "../test/tunnelPersistenceContract.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";
import * as PostgresManagedEndpointAllocations from "./PostgresManagedEndpointAllocations.ts";
import * as PostgresManagedTunnelLimits from "./PostgresManagedTunnelLimits.ts";
import * as PostgresTunnelOperations from "./PostgresTunnelOperations.ts";

const layer = Layer.mergeAll(
  PostgresEnvironmentLinks.layer,
  PostgresManagedEndpointAllocations.layer,
  PostgresManagedTunnelLimits.layer,
  PostgresTunnelOperations.layer,
).pipe(
  Layer.provide(layerLocalRelayDb),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(Layer.mock(T3ChatAccounts.T3ChatAccounts, { available: false })),
);
managedEndpointAllocationContract("Postgres managed allocations", layer);
managedTunnelLimitContract("Postgres managed capacity", layer);
