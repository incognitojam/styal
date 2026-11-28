import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";
import * as PostgresTunnelOperations from "./PostgresTunnelOperations.ts";
import { layerLocalRelayDb } from "../test/localRelayDb.ts";
import { tunnelOperationContract } from "../test/tunnelOperationContract.ts";

tunnelOperationContract(
  "Postgres tunnel operations",
  PostgresTunnelOperations.layer.pipe(
    Layer.provide(layerLocalRelayDb),
    Layer.provide(NodeCrypto.layer),
  ),
);
