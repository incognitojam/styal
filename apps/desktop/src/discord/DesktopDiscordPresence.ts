// @effect-diagnostics globalTimers:off -- Bounds and reconnects an imperative Discord RPC client.
import { Client } from "@xhayper/discord-rpc";
import {
  DISCORD_PRESENCE_BUTTON,
  formatDiscordPresenceDetails,
  type DesktopDiscordPresenceActivity,
  type DesktopDiscordPresenceStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

// Public application identifier, shared by every styal desktop installation.
const DISCORD_APPLICATION_ID = "1550496042082893854";
const RETRY_DELAY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 5_000;

type Activity = DesktopDiscordPresenceActivity | null;
type Status = DesktopDiscordPresenceStatus;

export interface DiscordRpcClient {
  readonly isConnected: boolean;
  readonly user:
    | {
        username: string;
        setActivity: (activity: {
          details: string;
          startTimestamp: number;
          buttons: { label: string; url: string }[];
        }) => Promise<unknown>;
        clearActivity: () => Promise<unknown>;
      }
    | undefined;
  login: () => Promise<unknown>;
  destroy: () => Promise<unknown>;
  on: (event: "disconnected", listener: () => void) => unknown;
}

export class DesktopDiscordPresence extends Context.Service<
  DesktopDiscordPresence,
  {
    readonly setActivity: (activity: Activity) => Effect.Effect<void>;
    readonly status: Effect.Effect<Status>;
  }
>()("@t3tools/desktop/discord/DesktopDiscordPresence") {}

/** `startTimestamp` pins Discord's elapsed timer, which otherwise restarts on every update. */
export function formatDiscordPresence(
  activity: DesktopDiscordPresenceActivity,
  startTimestamp: number,
) {
  return {
    details: formatDiscordPresenceDetails(activity),
    startTimestamp,
    buttons: [{ ...DISCORD_PRESENCE_BUTTON }],
  };
}

/** Serializes updates; only the latest counts survive a slow connection or retry. */
export class DiscordPresenceController {
  private desired: Activity = null;
  private applied: Activity = null;
  private client: DiscordRpcClient | null = null;
  private operation = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private currentStatus: Status = { _tag: "idle" };

  private readonly createClient: () => DiscordRpcClient;
  private readonly startedAt: number;
  private readonly onStatus: (status: Status) => void;

  /**
   * `startedAt` is the desktop launch time, reported to Discord as the activity start.
   * `onStatus` hears each change of {@link status}.
   */
  constructor(
    createClient: () => DiscordRpcClient,
    startedAt: number,
    onStatus: (status: Status) => void = () => {},
  ) {
    this.createClient = createClient;
    this.startedAt = startedAt;
    this.onStatus = onStatus;
  }

  get status(): Status {
    return this.currentStatus;
  }

  setActivity(activity: Activity): Promise<void> {
    if (this.disposed || this.equal(activity, this.desired)) return this.operation;
    this.desired = activity;
    this.clearRetry();
    return this.enqueue();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.desired = null;
    this.clearRetry();
    await this.operation;
    await this.disconnect();
  }

  private equal(left: Activity, right: Activity): boolean {
    return (
      left?.activeThreads === right?.activeThreads && left?.activeProjects === right?.activeProjects
    );
  }

  private enqueue(): Promise<void> {
    this.operation = this.operation
      .then(() => this.reconcile())
      .catch(async () => {
        await this.disconnect();
        this.setStatus(
          this.disposed || this.desired === null ? { _tag: "idle" } : { _tag: "unavailable" },
        );
        this.scheduleRetry();
      });
    return this.operation;
  }

  private async reconcile(): Promise<void> {
    if (this.disposed || this.desired === null) {
      await this.disconnect();
      this.setStatus({ _tag: "idle" });
      return;
    }
    if (!this.client?.isConnected) {
      await this.disconnect();
      if (this.disposed || this.desired === null) {
        this.setStatus({ _tag: "idle" });
        return;
      }
      // Retries stay `unavailable` rather than flickering through `connecting`.
      if (this.currentStatus._tag !== "unavailable") this.setStatus({ _tag: "connecting" });
      const client = this.createClient();
      this.client = client;
      client.on("disconnected", () => {
        if (this.client !== client) return;
        this.applied = null;
        this.setStatus({ _tag: "unavailable" });
        this.scheduleRetry();
      });
      await this.bounded(client.login());
    }
    if (this.disposed || this.desired === null) {
      await this.disconnect();
      this.setStatus({ _tag: "idle" });
      return;
    }
    if (this.equal(this.desired, this.applied)) return;
    const client = this.client;
    const user = client?.user;
    if (!user) throw new Error("Discord RPC has no user session.");
    const activity = this.desired;
    await this.bounded(user.setActivity(formatDiscordPresence(activity, this.startedAt)));
    // Discord may have disconnected while the update was in flight.
    if (this.client !== client) return;
    this.applied = activity;
    this.setStatus({ _tag: "connected", username: user.username });
  }

  private setStatus(status: Status): void {
    const current = this.currentStatus;
    if (
      this.disposed ||
      (current._tag === status._tag &&
        (current._tag !== "connected" ||
          (status._tag === "connected" && current.username === status.username)))
    ) {
      return;
    }
    this.currentStatus = status;
    this.onStatus(status);
  }

  private async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.applied = null;
    if (!client) return;
    if (client.isConnected && client.user) {
      await this.bounded(client.user.clearActivity()).catch(() => undefined);
    }
    await this.bounded(client.destroy()).catch(() => undefined);
  }

  private scheduleRetry(): void {
    if (this.disposed || this.desired === null || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.enqueue();
    }, RETRY_DELAY_MS);
    this.retryTimer.unref();
  }

  private clearRetry(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Discord RPC timed out.")), REQUEST_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

const make = Effect.fn("desktop.discordPresence.make")(function* (
  createClient: () => DiscordRpcClient = () => new Client({ clientId: DISCORD_APPLICATION_ID }),
) {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const startedAt = yield* Clock.currentTimeMillis;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const controller = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new DiscordPresenceController(createClient, startedAt, (status) => {
          runFork(electronWindow.sendAll(IpcChannels.DISCORD_PRESENCE_STATUS_CHANNEL, status));
        }),
    ),
    (controller) => Effect.promise(() => controller.dispose()),
  );
  return DesktopDiscordPresence.of({
    setActivity: (activity) => Effect.promise(() => controller.setActivity(activity)),
    status: Effect.sync(() => controller.status),
  });
});

export const layer = Layer.effect(DesktopDiscordPresence, make());
