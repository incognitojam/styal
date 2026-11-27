import * as Context from "effect/Context";

import type { EnvironmentLinks } from "../environments/EnvironmentLinks.ts";
import type { EnvironmentCredentials } from "../environments/EnvironmentCredentials.ts";
import type { AgentActivityRows } from "../agentActivity/AgentActivityRows.ts";

export class EnvironmentLinkPersistence extends Context.Service<
  EnvironmentLinkPersistence,
  EnvironmentLinks["Service"]
>()("t3code-relay/persistence/EnvironmentPersistence/EnvironmentLinkPersistence") {}

export class EnvironmentCredentialPersistence extends Context.Service<
  EnvironmentCredentialPersistence,
  EnvironmentCredentials["Service"]
>()("t3code-relay/persistence/EnvironmentPersistence/EnvironmentCredentialPersistence") {}

export class AgentActivityPersistence extends Context.Service<
  AgentActivityPersistence,
  AgentActivityRows["Service"]
>()("t3code-relay/persistence/EnvironmentPersistence/AgentActivityPersistence") {}
