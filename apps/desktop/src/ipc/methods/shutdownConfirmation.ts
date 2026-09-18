import { DesktopShutdownConfirmationRequestSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopShutdownConfirmation from "../../app/DesktopShutdownConfirmation.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getShutdownConfirmation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_SHUTDOWN_CONFIRMATION_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopShutdownConfirmationRequestSchema),
  handler: Effect.fn("desktop.ipc.getShutdownConfirmation")(function* () {
    return yield* (yield* DesktopShutdownConfirmation.DesktopShutdownConfirmation).current;
  }),
});

export const resolveShutdownConfirmation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESOLVE_SHUTDOWN_CONFIRMATION_CHANNEL,
  payload: Schema.Struct({ requestId: Schema.Int, confirmed: Schema.Boolean }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.resolveShutdownConfirmation")(function* ({
    requestId,
    confirmed,
  }) {
    const confirmation = yield* DesktopShutdownConfirmation.DesktopShutdownConfirmation;
    yield* confirmation.resolve(requestId, confirmed);
  }),
});
