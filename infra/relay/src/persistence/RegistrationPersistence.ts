import * as Context from "effect/Context";

import type { Devices } from "../agentActivity/Devices.ts";
import type { LiveActivities } from "../agentActivity/LiveActivities.ts";

export class DevicePersistence extends Context.Service<DevicePersistence, Devices["Service"]>()(
  "t3code-relay/persistence/RegistrationPersistence/DevicePersistence",
) {}

export class LiveActivityPersistence extends Context.Service<
  LiveActivityPersistence,
  LiveActivities["Service"]
>()("t3code-relay/persistence/RegistrationPersistence/LiveActivityPersistence") {}
