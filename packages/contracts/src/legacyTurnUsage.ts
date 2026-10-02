import * as Schema from "effect/Schema";

import { TurnId } from "./baseSchemas.ts";
import { ThreadTokenUsage, TurnModel, TurnTokenUsage } from "./providerRuntime.ts";

/** Frozen V1 usage, kept separately from V2 runs so migration invents no execution history. */
export const LegacyTurnUsage = Schema.Struct({
  records: Schema.Array(
    Schema.Struct({
      turnId: TurnId,
      usage: Schema.NullOr(TurnTokenUsage),
      model: Schema.NullOr(TurnModel),
    }),
  ),
  thread: ThreadTokenUsage,
});
export type LegacyTurnUsage = typeof LegacyTurnUsage.Type;
