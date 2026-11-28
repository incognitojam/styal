import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ApiPausePersistence } from "../persistence/DeliveryPersistence.ts";
import type { ApiPauseObject } from "./ApiPauseObject.ts";
import type { InventoryObject } from "./InventoryObject.ts";
import { apiPauseName, inventoryShardName } from "./names.ts";
import { RPC_VERSION as version } from "./storage.ts";

class ApiPauseStorageError extends Schema.TaggedError<ApiPauseStorageError>()(
  "ApiPauseStorageError",
  { cause: Schema.Defect() },
) {}

export interface ApiPauseBindings {
  API_PAUSES: Pick<DurableObjectNamespace<ApiPauseObject>, "getByName">;
  INVENTORY: Pick<DurableObjectNamespace<InventoryObject>, "getByName">;
}

export const apiPauseLayer = (bindings: ApiPauseBindings) => {
  const api = "cloudflare";
  const name = apiPauseName(api);
  return Layer.succeed(
    ApiPausePersistence,
    ApiPausePersistence.of({
      pausedUntilMillis: Effect.tryPromise({
        try: () => bindings.API_PAUSES.getByName(name).read({ version, api }),
        catch: (cause) => new ApiPauseStorageError({ cause }),
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not read the shared Cloudflare API pause", { cause }).pipe(
            Effect.as(0),
          ),
        ),
        Effect.withSpan("relay.object_api_pause.read"),
      ),
      pauseUntil: Effect.fn("relay.object_api_pause.record")(function (untilMillis) {
        return Effect.tryPromise({
          try: async () => {
            const stub = bindings.API_PAUSES.getByName(name);
            const first = await stub.extend({ version, api, untilMillis });
            if (!("needsRegistration" in first)) return;
            await bindings.INVENTORY.getByName(inventoryShardName("api-pause", name)).register({
              version,
              references: [{ kind: "api-pause", name }],
            });
            await stub.extend({ version, api, untilMillis, registered: true });
          },
          catch: (cause) => new ApiPauseStorageError({ cause }),
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not record the shared Cloudflare API pause", { cause }),
          ),
        );
      }),
    }),
  );
};
