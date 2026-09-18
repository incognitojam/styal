// @effect-diagnostics globalTimers:off -- Bounds and reconnects an imperative Discord RPC client.
import { Client } from "@xhayper/discord-rpc";
import type { DesktopDiscordPresenceActivity } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Public application identifier, shared by every styal desktop installation.
export const DISCORD_APPLICATION_ID = "1550496042082893854";
const RETRY_DELAY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 5_000;

type Activity = DesktopDiscordPresenceActivity | null;

export interface DiscordRpcClient {
  readonly isConnected: boolean;
  readonly user:
    | {
        setActivity: (activity: {
          details: string;
          state: string;
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
  { readonly setActivity: (activity: Activity) => Effect.Effect<void> }
>()("@t3tools/desktop/discord/DesktopDiscordPresence") {}

export function formatDiscordPresence(activity: DesktopDiscordPresenceActivity) {
  return {
    details: `${activity.activeThreads} active ${activity.activeThreads === 1 ? "thread" : "threads"}`,
    state: `Across ${activity.activeProjects} ${activity.activeProjects === 1 ? "project" : "projects"}`,
    buttons: [{ label: "View on GitHub", url: "https://github.com/incognitojam/styal" }],
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

  private readonly createClient: () => DiscordRpcClient;

  constructor(createClient: () => DiscordRpcClient) {
    this.createClient = createClient;
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
        this.scheduleRetry();
      });
    return this.operation;
  }

  private async reconcile(): Promise<void> {
    if (this.disposed || this.desired === null) {
      await this.disconnect();
      return;
    }
    if (!this.client?.isConnected) {
      await this.disconnect();
      if (this.disposed || this.desired === null) return;
      const client = this.createClient();
      this.client = client;
      client.on("disconnected", () => {
        if (this.client !== client) return;
        this.applied = null;
        this.scheduleRetry();
      });
      await this.bounded(client.login());
    }
    if (this.disposed || this.desired === null) {
      await this.disconnect();
      return;
    }
    if (this.equal(this.desired, this.applied)) return;
    const user = this.client?.user;
    if (!user) throw new Error("Discord RPC has no user session.");
    const activity = this.desired;
    await this.bounded(user.setActivity(formatDiscordPresence(activity)));
    this.applied = activity;
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

export const make = (
  createClient: () => DiscordRpcClient = () => new Client({ clientId: DISCORD_APPLICATION_ID }),
) =>
  Effect.acquireRelease(
    Effect.sync(() => new DiscordPresenceController(createClient)),
    (controller) => Effect.promise(() => controller.dispose()),
  ).pipe(
    Effect.map((controller) =>
      DesktopDiscordPresence.of({
        setActivity: (activity) => Effect.promise(() => controller.setActivity(activity)),
      }),
    ),
  );

export const layer = Layer.effect(DesktopDiscordPresence, make());
