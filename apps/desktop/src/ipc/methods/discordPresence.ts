import { DesktopDiscordPresenceActivity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopDiscordPresence from "../../discord/DesktopDiscordPresence.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const setDiscordPresence = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_DISCORD_PRESENCE_CHANNEL,
  payload: Schema.NullOr(DesktopDiscordPresenceActivity),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.discordPresence.set")(function* (activity) {
    const presence = yield* DesktopDiscordPresence.DesktopDiscordPresence;
    yield* presence.setActivity(activity);
  }),
});
