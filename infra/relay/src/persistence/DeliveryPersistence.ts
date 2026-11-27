import * as Context from "effect/Context";

import type { DeliveryAttempts } from "../agentActivity/DeliveryAttempts.ts";
import type { CloudflareApiPause } from "../environments/CloudflareApiPause.ts";

export class DeliveryAttemptPersistence extends Context.Service<
  DeliveryAttemptPersistence,
  DeliveryAttempts["Service"]
>()("t3code-relay/persistence/DeliveryPersistence/DeliveryAttemptPersistence") {}

export class ApiPausePersistence extends Context.Service<
  ApiPausePersistence,
  CloudflareApiPause["Service"]
>()("t3code-relay/persistence/DeliveryPersistence/ApiPausePersistence") {}
