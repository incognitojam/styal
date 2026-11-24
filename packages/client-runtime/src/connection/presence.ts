import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/** Whether someone can see the app: a visible page, or an active app on mobile. */
export type ApplicationPresenceState = "foreground" | "background";

interface ApplicationPresenceService {
  readonly current: Effect.Effect<ApplicationPresenceState>;
  /** Each change, and each return to the app even when the state did not change. */
  readonly changes: Stream.Stream<ApplicationPresenceState>;
}

export class ApplicationPresence extends Context.Reference<ApplicationPresenceService>(
  "@t3tools/client-runtime/connection/ApplicationPresence",
  {
    defaultValue: () => ({ current: Effect.succeed("foreground"), changes: Stream.never }),
  },
) {}

export const layer = (service: ApplicationPresenceService) =>
  Layer.succeed(ApplicationPresence, service);
