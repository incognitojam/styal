import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ApiPausePersistence } from "../persistence/DeliveryPersistence.ts";

/**
 * Cloudflare's account-wide 429 pause is shared across isolates and must fail open.
 * Run outside provisioning transactions: rollback would lose a recorded pause,
 * and a failed pause read would abort provisioning's own statements.
 */
export class CloudflareApiPause extends Context.Service<
  CloudflareApiPause,
  {
    /** Epoch milliseconds until which calls are paused, or 0. */
    readonly pausedUntilMillis: Effect.Effect<number>;
    readonly pauseUntil: (untilMillis: number) => Effect.Effect<void>;
  }
>()("t3code-relay/environments/CloudflareApiPause") {}

export const layer = Layer.effect(
  CloudflareApiPause,
  Effect.map(ApiPausePersistence, (store) => CloudflareApiPause.of(store)),
);
