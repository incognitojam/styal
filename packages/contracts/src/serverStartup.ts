import * as Schema from "effect/Schema";

export const STARTUP_COPY_MESSAGE = "Making a safety copy of your data. This only happens once.";
export const ServerStartupCopyProgress = Schema.Struct({
  phase: Schema.Literal("copying"),
  copiedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  leaseMs: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 60000 })),
});
export type ServerStartupCopyProgress = typeof ServerStartupCopyProgress.Type;
export const ServerStartupStatus = Schema.Struct({
  starting: Schema.optionalKey(Schema.Boolean),
  copy: Schema.NullOr(ServerStartupCopyProgress),
});
