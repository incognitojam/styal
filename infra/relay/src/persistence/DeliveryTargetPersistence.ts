import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { FcmDeliveryError } from "../agentActivity/FcmDeliveries.ts";

export type RegistrationCleanupScope =
  | { readonly kind: "account"; readonly userId: string }
  | { readonly kind: "session"; readonly userId: string; readonly sessionId: string }
  | { readonly kind: "sessions"; readonly sessionIds: ReadonlyArray<string> };

export interface RegistrationCleanupTarget {
  readonly userId: string;
  readonly deviceId: string;
  readonly token: string | null;
  readonly bundleId: string | null;
  readonly apsEnvironment: "sandbox" | "production" | null;
}

export class RegistrationCleanupReadError extends Schema.TaggedError<RegistrationCleanupReadError>()(
  "RegistrationCleanupReadError",
  { cause: Schema.Defect() },
) {}

export class RegistrationCleanupPersistence extends Context.Service<
  RegistrationCleanupPersistence,
  {
    readonly listTargets: (
      scope: RegistrationCleanupScope,
    ) => Effect.Effect<
      ReadonlyArray<RegistrationCleanupTarget>,
      RegistrationCleanupReadError | EffectDrizzleQueryError
    >;
  }
>()("t3code-relay/persistence/DeliveryTargetPersistence/RegistrationCleanupPersistence") {}

export class FcmTokenPersistence extends Context.Service<
  FcmTokenPersistence,
  {
    readonly invalidate: (input: {
      readonly userId: string;
      readonly deviceId: string;
      readonly token: string;
    }) => Effect.Effect<void, FcmDeliveryError>;
  }
>()("t3code-relay/persistence/DeliveryTargetPersistence/FcmTokenPersistence") {}
