import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";

import { layerLocalRelayDb } from "../test/localRelayDb.ts";
import {
  agentActivityContract,
  environmentCredentialContract,
  environmentLinkContract,
} from "../test/environmentPersistenceContract.ts";
import * as PostgresAgentActivityRows from "./PostgresAgentActivityRows.ts";
import * as PostgresEnvironmentCredentials from "./PostgresEnvironmentCredentials.ts";
import * as PostgresEnvironmentLinks from "./PostgresEnvironmentLinks.ts";

const layer = Layer.mergeAll(
  PostgresEnvironmentLinks.layer,
  PostgresEnvironmentCredentials.layer,
  PostgresAgentActivityRows.layer,
).pipe(Layer.provide(layerLocalRelayDb), Layer.provide(NodeCrypto.layer));

environmentLinkContract("Postgres environment links", layer);
environmentCredentialContract("Postgres environment credentials", layer);
agentActivityContract("Postgres agent activity", layer);
