import { EnvironmentId, FORK_CLIENT_USAGE_VERSION } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, stubGlobal } from "../../../test/render";

import { MentionedTimeChip } from "./MentionedTimeChip";

const { readConfig, run } = vi.hoisted(() => ({ readConfig: vi.fn(), run: vi.fn() }));

// Simulate a later client so an older positive server version is exercised too.
vi.mock("@t3tools/contracts", async (original) => ({
  ...(await original<typeof import("@t3tools/contracts")>()),
  FORK_CLIENT_USAGE_VERSION: 2,
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { get: readConfig } }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: (id: unknown) => id, reportForkClientUsage: { run } },
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { timestampFormat: "24-hour" }) => unknown) =>
    select({ timestampFormat: "24-hour" }),
}));

it("keeps explanations usable across version skew and reports each mounted chip at most once", async () => {
  using _matchMedia = stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  using _timers = fakeTimers();
  run.mockResolvedValue(AsyncResult.success(undefined));
  const environmentId = EnvironmentId.make("synthetic-environment");
  const chip = (key: string) => (
    <MentionedTimeChip
      key={key}
      environmentId={environmentId}
      time={{ kind: "clock", hour: 14, minute: 20, zone: { offsetMinutes: 0, name: "UTC" } }}
      anchor={{ writtenAtMs: Date.parse("2026-10-16T14:00:00Z"), environmentTimeZone: "UTC" }}
    >
      14:20 UTC
    </MentionedTimeChip>
  );
  const support = (capabilities: Record<string, number | boolean>) =>
    readConfig.mockReturnValue({ environment: { capabilities } });
  support({});
  await using screen = await render(chip("first"));
  const { container } = screen;
  const open = async () => {
    await act(async () => {
      const trigger = container.querySelector("span")!;
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mouseenter"));
      trigger.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(
      document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent,
    ).toBeTruthy();
  };
  const close = async () => {
    await act(async () => {
      container.querySelector("span")!.dispatchEvent(new MouseEvent("mouseleave"));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.querySelector('[data-slot="tooltip-popup"][data-open]')).toBeNull();
  };
  for (const capabilities of [{}, { forkClientUsage: true }, { forkClientUsageVersion: 1 }]) {
    support(capabilities);
    await open();
    expect(run).not.toHaveBeenCalled();
    await close();
  }
  support({ forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION });
  await open();
  expect(run).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    environmentId,
    input: { feature: "mentioned-time-chips", action: "details_opened" },
  });
  await close();
  await open();
  expect(run).toHaveBeenCalledOnce();
  await close();
  support({ forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION + 1 });
  run.mockRejectedValueOnce(new Error("Synthetic transport failure"));
  await screen.rerender(chip("remounted"));
  await open();
  expect(run).toHaveBeenCalledTimes(2);
  await close();
  await open();
  expect(run).toHaveBeenCalledTimes(2);
});
