import * as Context from "effect/Context";

import type { ManagedEndpointAllocations } from "../environments/ManagedEndpointAllocations.ts";
import type { ManagedTunnelLimits } from "../environments/ManagedTunnelLimits.ts";

export class ManagedEndpointAllocationPersistence extends Context.Service<
  ManagedEndpointAllocationPersistence,
  ManagedEndpointAllocations["Service"]
>()("t3code-relay/persistence/TunnelPersistence/ManagedEndpointAllocationPersistence") {}

export class ManagedTunnelLimitPersistence extends Context.Service<
  ManagedTunnelLimitPersistence,
  ManagedTunnelLimits["Service"]
>()("t3code-relay/persistence/TunnelPersistence/ManagedTunnelLimitPersistence") {}
