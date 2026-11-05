import {
  DesktopPreviewAppActionResultSchema,
  DesktopPreviewAppBuildLookupSchema,
  DesktopPreviewAppStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopPreviewApp from "../../previewApp/DesktopPreviewApp.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const PullRequestPayload = Schema.Struct({
  pullRequestNumber: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const getPreviewAppState = makeIpcMethod({
  channel: IpcChannels.PREVIEW_APP_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopPreviewAppStateSchema,
  handler: Effect.fn("desktop.ipc.previewApp.getState")(function* () {
    return yield* (yield* DesktopPreviewApp.DesktopPreviewApp).state;
  }),
});

export const findPreviewAppBuild = makeIpcMethod({
  channel: IpcChannels.PREVIEW_APP_FIND_BUILD_CHANNEL,
  payload: PullRequestPayload,
  result: DesktopPreviewAppBuildLookupSchema,
  handler: Effect.fn("desktop.ipc.previewApp.findBuild")(function* ({ pullRequestNumber }) {
    return yield* (yield* DesktopPreviewApp.DesktopPreviewApp).findBuild(pullRequestNumber);
  }),
});

export const installPreviewApp = makeIpcMethod({
  channel: IpcChannels.PREVIEW_APP_INSTALL_CHANNEL,
  payload: PullRequestPayload,
  result: DesktopPreviewAppActionResultSchema,
  handler: Effect.fn("desktop.ipc.previewApp.install")(function* ({ pullRequestNumber }) {
    return yield* (yield* DesktopPreviewApp.DesktopPreviewApp).install(pullRequestNumber);
  }),
});

export const cancelPreviewAppInstall = makeIpcMethod({
  channel: IpcChannels.PREVIEW_APP_CANCEL_INSTALL_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.previewApp.cancelInstall")(function* () {
    yield* (yield* DesktopPreviewApp.DesktopPreviewApp).cancelInstall;
  }),
});

export const openPreviewApp = makeIpcMethod({
  channel: IpcChannels.PREVIEW_APP_OPEN_CHANNEL,
  payload: Schema.Void,
  result: DesktopPreviewAppActionResultSchema,
  handler: Effect.fn("desktop.ipc.previewApp.open")(function* () {
    return yield* (yield* DesktopPreviewApp.DesktopPreviewApp).open;
  }),
});

export const removePreviewApp = makeIpcMethod({
  channel: IpcChannels.PREVIEW_APP_REMOVE_CHANNEL,
  payload: Schema.Void,
  result: DesktopPreviewAppActionResultSchema,
  handler: Effect.fn("desktop.ipc.previewApp.remove")(function* () {
    return yield* (yield* DesktopPreviewApp.DesktopPreviewApp).remove;
  }),
});

export const resetPreviewAppData = makeIpcMethod({
  channel: IpcChannels.PREVIEW_APP_RESET_DATA_CHANNEL,
  payload: Schema.Void,
  result: DesktopPreviewAppActionResultSchema,
  handler: Effect.fn("desktop.ipc.previewApp.resetData")(function* () {
    return yield* (yield* DesktopPreviewApp.DesktopPreviewApp).resetData;
  }),
});
