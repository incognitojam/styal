import { act, type ReactElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  hostActivity: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
  copy: vi.fn(),
  continueThreadsAfterServerUpdate: false,
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: testState.copy }),
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: (
    _environmentId: EnvironmentId,
    selector: (settings: { continueThreadsAfterServerUpdate: boolean }) => unknown,
  ) => selector({ continueThreadsAfterServerUpdate: testState.continueThreadsAfterServerUpdate }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { updateServer: "updateServer", hostActivity: "hostActivity" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "hostActivity" ? testState.hostActivity : testState.updateServer,
}));
vi.mock("~/confirmDialog", () => ({
  requestConfirmDialog: testState.confirm,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.toast },
}));

import {
  ServerUpdateAction,
  ServerUpdateProgress,
  ServerUpdatesAction,
  type ServerUpdateTarget,
} from "./ServerUpdateAction";

type ActionElement = ReactElement<{
  readonly onClick?: () => void;
}>;

function renderAction(): ActionElement {
  return ServerUpdateAction({
    environmentId: "env-test" as EnvironmentId,
    serverLabel: "Test server",
    selfUpdate: "boot-service",
    targetVersion: "0.0.31",
  }) as ActionElement;
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

const idleActivity = {
  activeSessions: 0,
  continuableSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
};

describe("ServerUpdateAction", () => {
  beforeEach(() => {
    testState.updateServer.mockReset();
    testState.hostActivity.mockReset();
    testState.hostActivity.mockResolvedValue(AsyncResult.success(idleActivity));
    // No confirm-dialog host is mounted, which the component treats as consent.
    testState.confirm.mockReset();
    testState.confirm.mockReturnValue(undefined);
    testState.toast.mockReset();
    testState.copy.mockReset();
    testState.continueThreadsAfterServerUpdate = false;
  });

  it("reports success only after the shared update flow reconnects", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );

    renderAction().props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
    expect(testState.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Test server updated",
      description: "Reconnected on @styal/cli@0.0.31.",
    });
  });

  it("reports one result when the update action is double-clicked", async () => {
    let finishUpdate: (() => void) | undefined;
    testState.updateServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpdate = () =>
            resolve(
              AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
            );
        }),
    );

    const action = renderAction();
    action.props.onClick?.();
    action.props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledTimes(1);
    finishUpdate?.();
    await flushPromises();
    expect(testState.toast).toHaveBeenCalledTimes(1);
  });

  it("quietly releases the action when the operation is interrupted", async () => {
    testState.updateServer.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));

    renderAction().props.onClick?.();
    await flushPromises();

    expect(testState.toast).not.toHaveBeenCalled();
  });

  it("keeps the manual instruction for desktop servers without remote update support", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateAction
        environmentId={"env-test" as EnvironmentId}
        serverLabel="Test server"
        selfUpdate="desktop-managed"
        targetVersion="0.0.31"
      />,
    );

    expect(markup).toContain("Update the desktop app on that machine to update this server.");
    expect(markup).not.toContain("<button");
  });

  it("updates remote desktop apps through the shared update flow", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.34", method: "desktop-app" as const }),
    );

    const action = ServerUpdateAction({
      environmentId: "env-test" as EnvironmentId,
      serverLabel: "Test server",
      selfUpdate: "desktop-managed",
      desktopAppUpdate: true,
      targetVersion: "0.0.31",
    }) as ActionElement;

    action.props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
    expect(testState.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Test server updated",
      description: "Desktop app relaunched on 0.0.34.",
    });
  });

  it("updates an idle server without asking", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );

    renderAction().props.onClick?.();
    await flushPromises();

    expect(testState.confirm).not.toHaveBeenCalled();
    expect(testState.updateServer).toHaveBeenCalledTimes(1);
  });

  it("keeps running work when the user cancels the confirmation", async () => {
    testState.hostActivity.mockResolvedValue(
      AsyncResult.success({ ...idleActivity, activeSessions: 1 }),
    );
    testState.confirm.mockResolvedValue(false);

    renderAction().props.onClick?.();
    await flushPromises();

    expect(testState.confirm).toHaveBeenCalledWith(
      expect.stringContaining("1 thread will be interrupted."),
      { confirmLabel: "Update" },
    );
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("updates after the user confirms interrupting running work", async () => {
    testState.hostActivity.mockResolvedValue(
      AsyncResult.success({ ...idleActivity, terminalsRequiringConfirmation: 2 }),
    );
    testState.confirm.mockResolvedValue(true);
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );

    renderAction().props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledTimes(1);
  });

  it("asks before updating when activity cannot be checked", async () => {
    testState.hostActivity.mockResolvedValue(AsyncResult.failure(Cause.fail("unavailable")));
    testState.confirm.mockResolvedValue(false);

    renderAction().props.onClick?.();
    await flushPromises();

    expect(testState.confirm).toHaveBeenCalledWith(
      expect.stringContaining("Could not check the Test server for running work."),
      { confirmLabel: "Update" },
    );
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("leaves thread continuation off by default", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );
    const action = ServerUpdateAction({
      environmentId: "env-test" as EnvironmentId,
      serverLabel: "Test server",
      selfUpdate: "boot-service",
      threadContinuation: true,
      targetVersion: "0.0.31",
    }) as ActionElement;

    action.props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
  });

  it("applies the saved thread continuation preference automatically", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );
    testState.continueThreadsAfterServerUpdate = true;
    const action = ServerUpdateAction({
      environmentId: "env-test" as EnvironmentId,
      serverLabel: "Test server",
      selfUpdate: "boot-service",
      threadContinuation: true,
      targetVersion: "0.0.31",
    }) as ActionElement;

    action.props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31", continueRunningThreads: true },
    });
  });
});

describe("ServerUpdatesAction", () => {
  let renderer: ReactTestRenderer | undefined;
  const targets: ReadonlyArray<ServerUpdateTarget> = [
    {
      environmentId: "batch-a" as EnvironmentId,
      serverLabel: "Laptop",
      selfUpdate: "boot-service",
      targetVersion: "0.0.31",
      threadContinuation: true,
      continueThreadsAfterServerUpdate: true,
    },
    {
      environmentId: "batch-b" as EnvironmentId,
      serverLabel: "Office",
      selfUpdate: "respawn",
      targetVersion: "0.0.31",
      threadContinuation: true,
      continueThreadsAfterServerUpdate: false,
    },
    {
      environmentId: "batch-c" as EnvironmentId,
      serverLabel: "Manual",
      selfUpdate: null,
      targetVersion: "0.0.31",
    },
  ];
  const success = AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const });

  async function mount(batch = targets) {
    await act(async () => {
      renderer = create(<ServerUpdatesAction targets={batch} />);
    });
    return renderer!.root.findByType("button");
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    testState.updateServer.mockReset();
    testState.hostActivity.mockReset();
    testState.hostActivity.mockResolvedValue(AsyncResult.success(idleActivity));
    testState.confirm.mockReset();
    testState.confirm.mockReturnValue(undefined);
    testState.toast.mockReset();
  });
  afterEach(async () => {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("updates both supported machines with their own continuation preference and skips the manual machine", async () => {
    testState.updateServer.mockResolvedValue(success);
    const button = await mount();
    await act(async () => {
      button.props.onClick();
    });

    expect(testState.updateServer.mock.calls.map(([target]) => target)).toEqual([
      {
        environmentId: "batch-a",
        input: { targetVersion: "0.0.31", continueRunningThreads: true },
      },
      { environmentId: "batch-b", input: { targetVersion: "0.0.31" } },
    ]);
    expect(testState.toast.mock.calls.map(([toast]) => toast.title)).toEqual([
      "Laptop updated",
      "Office updated",
    ]);
  });

  it("names a failed machine while letting the other machine complete", async () => {
    testState.updateServer
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Download failed"))))
      .mockResolvedValueOnce(success);
    const button = await mount();
    await act(async () => {
      button.props.onClick();
    });

    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(testState.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Laptop update failed",
      description: "Download failed",
    });
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Office updated" }),
    );
    expect(button.props.disabled).toBe(false);
  });

  it("starts each machine once when double-clicked and disables the action until both finish", async () => {
    const completions: Array<() => void> = [];
    testState.updateServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          completions.push(() => resolve(success));
        }),
    );
    const button = await mount();
    await act(async () => {
      button.props.onClick();
      button.props.onClick();
    });
    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(button.props.disabled).toBe(true);
    await act(async () => {
      completions[0]!();
    });
    expect(button.props.disabled).toBe(true);
    await act(async () => {
      completions[1]!();
    });
    expect(button.props.disabled).toBe(false);
    expect(testState.toast).toHaveBeenCalledTimes(2);
  });

  it("asks once for desktop machines and cancels the entire batch", async () => {
    testState.confirm.mockResolvedValue(false);
    const button = await mount(
      targets.map((target, index) =>
        index < 2 ? { ...target, selfUpdate: "desktop-managed", desktopAppUpdate: true } : target,
      ),
    );
    await act(async () => {
      button.props.onClick();
    });

    expect(testState.confirm).toHaveBeenCalledTimes(1);
    expect(testState.confirm).toHaveBeenCalledWith(expect.stringContaining("Laptop, Office"), {
      confirmLabel: "Update",
    });
    expect(testState.updateServer).not.toHaveBeenCalled();
    expect(button.props.disabled).toBe(false);
  });

  it("asks once when work is running on any machine in the batch", async () => {
    testState.hostActivity
      .mockResolvedValueOnce(AsyncResult.success(idleActivity))
      .mockResolvedValueOnce(AsyncResult.success({ ...idleActivity, activeSessions: 2 }));
    testState.confirm.mockResolvedValue(true);
    testState.updateServer.mockResolvedValue(success);
    const button = await mount();
    await act(async () => {
      button.props.onClick();
    });

    expect(testState.hostActivity).toHaveBeenCalledTimes(2);
    expect(testState.confirm).toHaveBeenCalledTimes(1);
    expect(testState.confirm).toHaveBeenCalledWith(
      expect.stringContaining("2 threads will be interrupted."),
      { confirmLabel: "Update" },
    );
    expect(testState.updateServer).toHaveBeenCalledTimes(2);
  });
});

describe("ServerUpdateProgress", () => {
  it("shows one calm status row for the restart wait", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "resuming",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );

    expect(markup).toContain("Restarting…");
    // The wait state is monochrome and calm: no versions, no step rail, no
    // success/warning colors, one duty-cycled pulse on the dot.
    expect(markup).not.toContain("0.0.30");
    expect(markup).not.toContain("Resum");
    expect(markup).not.toContain("text-success");
    expect(markup).not.toContain("text-primary");
    expect(markup).toContain("animate-status-pulse");
    expect(markup).not.toContain("animate-spin");
  });

  it("folds the sub-second installing handoff into the download phase", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );

    expect(markup).toContain("Downloading…");
    expect(markup).not.toContain("Install");
  });

  it("keeps the failure visible with its retryable error", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "failed",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
          message: "The package could not be verified.",
        }}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The package could not be verified.");
    expect(markup).not.toContain("animate-status-pulse");
  });
});
