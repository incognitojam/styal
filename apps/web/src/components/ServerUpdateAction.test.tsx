import { act, type ReactElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthSessionState, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "~/confirmDialog";

const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  hostActivity: vi.fn(),
  toast: vi.fn(),
  copy: vi.fn(),
  session: null as AsyncResult.AsyncResult<AuthSessionState, Error> | null,
  sessionAtom: Symbol("session"),
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: testState.copy }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => testState.session }));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => testState.session },
}));
vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: () => testState.sessionAtom },
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { updateServer: "updateServer", hostActivity: "hostActivity" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "hostActivity" ? testState.hostActivity : testState.updateServer,
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

const decodeSessionState = Schema.decodeUnknownSync(AuthSessionState);

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

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
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
  environmentsUsingDevices: 0,
};

const legacyAuth = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "t3_session",
} as const;

const currentSession = {
  authenticated: true,
  scopes: ["environment:maintain"],
  auth: {
    ...legacyAuth,
    serverUpdateScope: "environment:maintain",
  },
} as const satisfies AuthSessionState;

describe("ServerUpdateAction", () => {
  beforeEach(() => {
    testState.updateServer.mockReset();
    testState.hostActivity.mockReset();
    testState.hostActivity.mockResolvedValue(AsyncResult.success(idleActivity));
    resetConfirmDialogForTests();
    testState.toast.mockReset();
    testState.copy.mockReset();
    testState.session = AsyncResult.success(currentSession);
  });

  it.each([
    { serverUpdateScope: undefined, scopes: ["orchestration:operate"], allowed: true },
    { serverUpdateScope: undefined, scopes: ["orchestration:read"], allowed: false },
    {
      serverUpdateScope: "environment:maintain",
      scopes: ["orchestration:operate"],
      allowed: false,
    },
    {
      serverUpdateScope: "environment:maintain",
      scopes: ["environment:maintain"],
      allowed: true,
    },
  ] as const)(
    "uses the advertised update scope $serverUpdateScope with grant $scopes",
    async ({ serverUpdateScope, scopes, allowed }) => {
      testState.session = AsyncResult.success(
        decodeSessionState({
          ...currentSession,
          scopes,
          auth: {
            ...legacyAuth,
            ...(serverUpdateScope === undefined ? {} : { serverUpdateScope }),
          },
        }),
      );
      testState.updateServer.mockResolvedValue(
        AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
      );

      renderAction().props.onClick?.();
      await flushPromises();

      expect(testState.updateServer).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it("keeps a known grant usable while the session refreshes", async () => {
    testState.session = AsyncResult.waiting(AsyncResult.success(currentSession));
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );

    renderAction().props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledOnce();
  });

  it("does not dispatch an update after maintenance access is removed", async () => {
    const action = renderAction();
    testState.session = AsyncResult.success({ ...currentSession, scopes: [] });
    action.props.onClick?.();
    await flushPromises();
    expect(testState.updateServer).not.toHaveBeenCalled();
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
    registerConfirmDialogHost();
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );

    renderAction().props.onClick?.();
    await flushPromises();

    expect(readConfirmDialogState().status).toBe("idle");
    expect(testState.updateServer).toHaveBeenCalledTimes(1);
  });

  it("opens immediately and prevents updates until running work has been checked", async () => {
    registerConfirmDialogHost();
    const result = AsyncResult.success({ ...idleActivity, activeSessions: 1 });
    const activity = deferred<typeof result>();
    testState.hostActivity.mockReturnValue(activity.promise);
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );

    const action = renderAction();
    action.props.onClick?.();
    action.props.onClick?.();
    expect(readConfirmDialogState()).toMatchObject({
      status: "confirming",
      loading: true,
      message: "Update the Test server?\nChecking for running work…",
    });
    expect(testState.hostActivity).toHaveBeenCalledTimes(1);
    respondToConfirmDialog(true);
    await flushPromises();
    expect(testState.updateServer).not.toHaveBeenCalled();

    activity.resolve(result);
    await flushPromises();
    expect(readConfirmDialogState()).toMatchObject({
      status: "confirming",
      message: expect.stringContaining("1 thread will be interrupted."),
    });
    expect(readConfirmDialogState()).not.toHaveProperty("loading");
    respondToConfirmDialog(true);
    await flushPromises();
    expect(testState.updateServer).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending check immediately and ignores its result after a retry", async () => {
    registerConfirmDialogHost();
    const result = AsyncResult.success(idleActivity);
    const activity = deferred<typeof result>();
    testState.hostActivity
      .mockReturnValueOnce(activity.promise)
      .mockResolvedValue(AsyncResult.success({ ...idleActivity, activeSessions: 2 }));
    const action = renderAction();
    action.props.onClick?.();
    respondToConfirmDialog(false);
    await flushPromises();
    completeConfirmDialogClose();
    expect(readConfirmDialogState().status).toBe("idle");

    action.props.onClick?.();
    await flushPromises();
    activity.resolve(result);
    await flushPromises();
    expect(readConfirmDialogState()).toMatchObject({
      status: "confirming",
      message: expect.stringContaining("2 threads will be interrupted."),
    });
    expect(testState.updateServer).not.toHaveBeenCalled();
    respondToConfirmDialog(false);
    await flushPromises();
  });

  it("keeps running work when the user cancels the confirmation", async () => {
    testState.hostActivity.mockResolvedValue(
      AsyncResult.success({ ...idleActivity, activeSessions: 1 }),
    );
    registerConfirmDialogHost();

    renderAction().props.onClick?.();
    await flushPromises();

    expect(readConfirmDialogState()).toMatchObject({
      message: expect.stringContaining("1 thread will be interrupted."),
      confirmLabel: "Update",
    });
    respondToConfirmDialog(false);
    await flushPromises();
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("updates after the user confirms interrupting running work", async () => {
    testState.hostActivity.mockResolvedValue(
      AsyncResult.success({ ...idleActivity, terminalsRequiringConfirmation: 2 }),
    );
    registerConfirmDialogHost();
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );

    renderAction().props.onClick?.();
    await flushPromises();
    respondToConfirmDialog(true);
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledTimes(1);
  });

  it("asks before updating when activity cannot be checked", async () => {
    testState.hostActivity.mockResolvedValue(AsyncResult.failure(Cause.fail("unavailable")));
    registerConfirmDialogHost();

    renderAction().props.onClick?.();
    await flushPromises();

    expect(readConfirmDialogState()).toMatchObject({
      message: expect.stringContaining("Could not check the Test server for running work."),
      confirmLabel: "Update",
    });
    respondToConfirmDialog(false);
    await flushPromises();
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("does not request continuation from a server without it", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );
    const action = ServerUpdateAction({
      environmentId: "env-test" as EnvironmentId,
      serverLabel: "Test server",
      selfUpdate: "boot-service",
      targetVersion: "0.0.31",
    }) as ActionElement;

    action.props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
  });

  it("requests continuation from a server that supports it", async () => {
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
    },
    {
      environmentId: "batch-b" as EnvironmentId,
      serverLabel: "Office",
      selfUpdate: "respawn",
      targetVersion: "0.0.31",
      threadContinuation: false,
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
    resetConfirmDialogForTests();
    testState.toast.mockReset();
  });
  afterEach(async () => {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("updates both supported machines with their own continuation support and skips the manual machine", async () => {
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
    registerConfirmDialogHost();
    const button = await mount(
      targets.map((target, index) =>
        index < 2 ? { ...target, selfUpdate: "desktop-managed", desktopAppUpdate: true } : target,
      ),
    );
    await act(async () => {
      button.props.onClick();
    });

    expect(readConfirmDialogState()).toMatchObject({
      message: expect.stringContaining("Laptop, Office"),
      confirmLabel: "Update",
    });
    await act(async () => respondToConfirmDialog(false));
    expect(testState.updateServer).not.toHaveBeenCalled();
    expect(button.props.disabled).toBe(false);
  });

  it("asks once when work is running on any machine in the batch", async () => {
    testState.hostActivity
      .mockResolvedValueOnce(AsyncResult.success(idleActivity))
      .mockResolvedValueOnce(AsyncResult.success({ ...idleActivity, activeSessions: 2 }));
    registerConfirmDialogHost();
    testState.updateServer.mockResolvedValue(success);
    const button = await mount();
    await act(async () => {
      button.props.onClick();
    });

    expect(testState.hostActivity).toHaveBeenCalledTimes(2);
    expect(readConfirmDialogState()).toMatchObject({
      message: expect.stringContaining("2 threads will be interrupted."),
      confirmLabel: "Update",
    });
    expect(testState.updateServer).not.toHaveBeenCalled();
    await act(async () => respondToConfirmDialog(true));
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
    // success/warning colors, and a static dot that never repaints.
    expect(markup).not.toContain("0.0.30");
    expect(markup).not.toContain("Resum");
    expect(markup).not.toContain("text-success");
    expect(markup).not.toContain("text-primary");
    expect(markup).not.toContain("animate-");
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
