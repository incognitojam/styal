import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DiscordPresenceController, type DiscordRpcClient } from "./DesktopDiscordPresence.ts";

function fakeClient() {
  let connected = false;
  let onDisconnect = () => {};
  const client = {
    get isConnected() {
      return connected;
    },
    user: { setActivity: vi.fn(async () => {}), clearActivity: vi.fn(async () => {}) },
    login: vi.fn(async () => {
      connected = true;
    }),
    destroy: vi.fn(async () => {
      connected = false;
      onDisconnect();
    }),
    on: (_event: "disconnected", listener: () => void) => {
      onDisconnect = listener;
    },
    disconnect: () => {
      connected = false;
      onDisconnect();
    },
  } satisfies DiscordRpcClient & { disconnect: () => void };
  return client;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Discord presence lifecycle", () => {
  it("connects lazily, publishes counts and the public repository link, deduplicates updates, and clears on disable", async () => {
    const client = fakeClient();
    const create = vi.fn(() => client);
    const controller = new DiscordPresenceController(create);
    await controller.setActivity(null);
    expect(create).not.toHaveBeenCalled();
    await controller.setActivity({ activeThreads: 3, activeProjects: 2 });
    await controller.setActivity({ activeThreads: 3, activeProjects: 2 });
    expect(client.user.setActivity).toHaveBeenCalledExactlyOnceWith({
      details: "3 active threads across 2 projects",
      buttons: [{ label: "View on GitHub", url: "https://github.com/incognitojam/styal" }],
    });
    await controller.setActivity({ activeThreads: 1, activeProjects: 1 });
    expect(client.user.setActivity).toHaveBeenLastCalledWith({
      details: "1 active thread across 1 project",
      buttons: [{ label: "View on GitHub", url: "https://github.com/incognitojam/styal" }],
    });
    await controller.setActivity(null);
    expect(client.user.clearActivity).toHaveBeenCalledTimes(1);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    await controller.dispose();
  });

  it("reconnects after Discord closes and republishes unchanged counts", async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    const controller = new DiscordPresenceController(() => client);
    await controller.setActivity({ activeThreads: 2, activeProjects: 1 });
    client.disconnect();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(client.login).toHaveBeenCalledTimes(2);
    expect(client.user.setActivity).toHaveBeenCalledTimes(2);
    await controller.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.login).toHaveBeenCalledTimes(2);
  });

  it("recovers when Discord was absent at startup, and cancels retries when disabled", async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    client.login.mockRejectedValueOnce(new Error("Discord is not running"));
    const controller = new DiscordPresenceController(() => client);
    await controller.setActivity({ activeThreads: 1, activeProjects: 1 });
    expect(client.user.setActivity).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(client.user.setActivity).toHaveBeenCalledTimes(1);
    client.disconnect();
    await controller.setActivity(null);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.login).toHaveBeenCalledTimes(2);
    await controller.dispose();
  });

  it("does not publish if disabled during a pending connection", async () => {
    const client = fakeClient();
    const login = Promise.withResolvers<void>();
    const connecting = Promise.withResolvers<void>();
    client.login.mockImplementationOnce(() => {
      connecting.resolve();
      return login.promise;
    });
    const controller = new DiscordPresenceController(() => client);
    const update = controller.setActivity({ activeThreads: 3, activeProjects: 2 });
    await connecting.promise;
    const disable = controller.setActivity(null);
    login.resolve();
    await Promise.all([update, disable]);
    expect(client.user.setActivity).not.toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalled();
    await controller.dispose();
  });

  it("bounds stalled RPC requests so disable and shutdown can finish", async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    client.user.setActivity.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new DiscordPresenceController(() => client);
    const update = controller.setActivity({ activeThreads: 1, activeProjects: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    await update;
    await controller.dispose();
    expect(client.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
