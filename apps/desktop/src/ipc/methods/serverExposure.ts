import {
  AdvertisedEndpoint,
  DesktopServerExposureModeSchema,
  DesktopServerExposureStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopServerExposure from "../../backend/DesktopServerExposure.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const SetTailscaleServeEnabledInput = Schema.Struct({
  enabled: Schema.Boolean,
  port: Schema.optionalKey(Schema.Number),
});

export const getServerExposureState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_SERVER_EXPOSURE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopServerExposureStateSchema,
  handler: Effect.fn("desktop.ipc.serverExposure.getState")(function* () {
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    return yield* serverExposure.getState;
  }),
});

export const setServerExposureMode = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_SERVER_EXPOSURE_MODE_CHANNEL,
  payload: DesktopServerExposureModeSchema,
  result: DesktopServerExposureStateSchema,
  handler: Effect.fn("desktop.ipc.serverExposure.setMode")(function* (mode) {
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const previousSettings = yield* appSettings.get;
    const previousConfig = yield* serverExposure.backendConfig;
    const change = yield* serverExposure.setMode(mode);
    if (change.requiresRelaunch) {
      if (!(yield* lifecycle.relaunch(`serverExposureMode=${mode}`))) {
        yield* appSettings.setServerExposureMode(previousSettings.serverExposureMode);
        return yield* serverExposure.configureFromSettings({ port: previousConfig.port });
      }
    }
    return change.state;
  }),
});

export const setTailscaleServeEnabled = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_TAILSCALE_SERVE_ENABLED_CHANNEL,
  payload: SetTailscaleServeEnabledInput,
  result: DesktopServerExposureStateSchema,
  handler: Effect.fn("desktop.ipc.serverExposure.setTailscaleServeEnabled")(function* (input) {
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const previous = yield* serverExposure.getState;
    const change = yield* serverExposure.setTailscaleServeEnabled(input);
    if (change.requiresRelaunch) {
      if (
        !(yield* lifecycle.relaunch(
          change.state.tailscaleServeEnabled
            ? "tailscale-serve-enabled"
            : "tailscale-serve-disabled",
        ))
      ) {
        const restored = yield* serverExposure.setTailscaleServeEnabled({
          enabled: previous.tailscaleServeEnabled,
          port: previous.tailscaleServePort,
        });
        return restored.state;
      }
    }
    return change.state;
  }),
});

export const getAdvertisedEndpoints = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_ADVERTISED_ENDPOINTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(AdvertisedEndpoint),
  handler: Effect.fn("desktop.ipc.serverExposure.getAdvertisedEndpoints")(function* () {
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    return yield* serverExposure.getAdvertisedEndpoints;
  }),
});
