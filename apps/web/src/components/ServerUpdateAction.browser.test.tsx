import { RegistryContext } from "@effect/atom-react";
import {
  AuthSessionState,
  ThreadId,
  summarizeDesktopUpdateActivity,
  type EnvironmentId,
  type HostActivity,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../test/render";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  hostActivity: vi.fn(),
  desktopActivity: vi.fn(),
  toast: vi.fn(),
  copy: vi.fn(),
  sessionAtom: null as unknown,
}));

vi.mock(import("~/hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  useCopyToClipboard: (() => ({ copyToClipboard: testState.copy, isCopied: false })) as never,
}));
vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      sessionStateAtom: (() => testState.sessionAtom) as never,
    },
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { serverEnvironment } = await import("~/state/server");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) => {
      if (command === serverEnvironment.hostActivity) return testState.hostActivity;
      if (command === serverEnvironment.desktopHostActivity) return testState.desktopActivity;
      return testState.updateServer;
    }) as never,
  };
});
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } };
});

import {
  resetConfirmDialogForTests,
  readConfirmDialogState,
  registerConfirmDialogHost,
  respondToConfirmDialog,
} from "~/confirmDialog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  ServerUpdateAction,
  OutdatedServerUpdateAction,
  ServerUpdatesAction,
  type ServerUpdateTarget,
} from "./ServerUpdateAction";

const decodeSessionState = Schema.decodeUnknownSync(AuthSessionState);

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

const success = (method: "boot-service" | "desktop-app" = "boot-service", version = "0.0.31") =>
  AsyncResult.success({ targetVersion: version, method });

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

let sessionAtom: Atom.Writable<SessionResult>;

function setSession(session: SessionResult) {
  appAtomRegistry.set(sessionAtom, session);
}

function setup(): Disposable {
  testState.updateServer.mockReset();
  testState.hostActivity.mockReset();
  testState.hostActivity.mockResolvedValue(AsyncResult.success(idleActivity));
  testState.desktopActivity
    .mockReset()
    .mockResolvedValue(AsyncResult.success([{ ...idleActivity, isRequestingEnvironment: true }]));
  testState.toast.mockReset();
  testState.copy.mockReset();
  sessionAtom = Atom.make<SessionResult>(AsyncResult.success(currentSession));
  testState.sessionAtom = sessionAtom;
  resetConfirmDialogForTests();
  return { [Symbol.dispose]: resetConfirmDialogForTests };
}

function renderUpdate(element: ReactNode) {
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>{element}</RegistryContext.Provider>,
  );
}

function button(screen: Screen, name?: string) {
  const buttons = [...screen.container.querySelectorAll("button")];
  return name === undefined
    ? buttons[0]
    : buttons.find((element) => element.textContent?.trim() === name);
}

async function click(screen: Screen, name?: string) {
  await act(async () => button(screen, name)!.click());
}

function renderAction(props: Partial<Parameters<typeof ServerUpdateAction>[0]> = {}) {
  return renderUpdate(
    <ServerUpdateAction
      environmentId={"env-test" as EnvironmentId}
      serverLabel="Test server"
      selfUpdate="boot-service"
      targetVersion="0.0.31"
      {...props}
    />,
  );
}

describe("ServerUpdateAction", () => {
  it.each(["boot-service", "desktop-managed"] as const)(
    "updates resumable work on a %s host without an affirmative confirmation",
    async (selfUpdate) => {
      using _state = setup();
      registerConfirmDialogHost();
      const result = AsyncResult.success({
        ...idleActivity,
        activeSessions: 1,
        continuableSessions: 1,
        threads: [
          {
            threadId: ThreadId.make("release"),
            title: "Prepare release",
            reasons: ["running" as const],
            continuable: true,
          },
        ],
      });
      const activity = deferred<typeof result>();
      testState.hostActivity.mockReturnValue(activity.promise);
      testState.desktopActivity.mockReturnValue(
        activity.promise.then((snapshot) =>
          AsyncResult.success([
            { ...summarizeDesktopUpdateActivity(snapshot.value), isRequestingEnvironment: true },
          ]),
        ),
      );
      testState.updateServer.mockResolvedValue(
        success(selfUpdate === "desktop-managed" ? "desktop-app" : "boot-service"),
      );

      await using screen = await renderAction({
        selfUpdate,
        desktopAppUpdate: true,
        threadContinuation: true,
      });
      await click(screen, "Update");
      expect(readConfirmDialogState().status).toBe("idle");
      expect(button(screen, "Update")!.disabled).toBe(true);
      expect(testState.updateServer).not.toHaveBeenCalled();

      await act(async () => activity.resolve(result));
      expect(readConfirmDialogState().status).toBe("idle");
      expect(
        selfUpdate === "desktop-managed" ? testState.desktopActivity : testState.hostActivity,
      ).toHaveBeenCalledTimes(1);
      expect(testState.updateServer).toHaveBeenCalledExactlyOnceWith({
        environmentId: "env-test",
        input: { targetVersion: "0.0.31", confirmed: false, continueRunningThreads: true },
      });
      expect(testState.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
    },
  );

  it.each([
    {
      name: "a terminal command",
      blocker: { terminalsRequiringConfirmation: 1 },
      warning: "1 terminal session will be interrupted.",
    },
  ])("requires consent for $name alongside resumable work", async ({ blocker, warning }) => {
    using _state = setup();
    registerConfirmDialogHost();
    testState.hostActivity.mockResolvedValue(
      AsyncResult.success({
        ...idleActivity,
        activeSessions: 1,
        continuableSessions: 1,
        ...blocker,
      } satisfies HostActivity),
    );
    await using screen = await renderAction({ threadContinuation: true });
    await click(screen, "Update");
    expect(readConfirmDialogState()).toMatchObject({
      status: "confirming",
      message: expect.stringContaining(warning),
    });
    expect(testState.updateServer).not.toHaveBeenCalled();
    await act(async () => respondToConfirmDialog(false));
    expect(testState.updateServer).not.toHaveBeenCalled();
    expect(testState.toast).not.toHaveBeenCalled();
    expect(button(screen, "Update")!.disabled).toBe(false);
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
      using _state = setup();
      setSession(
        AsyncResult.success(
          decodeSessionState({
            ...currentSession,
            scopes,
            auth: {
              ...legacyAuth,
              ...(serverUpdateScope === undefined ? {} : { serverUpdateScope }),
            },
          }),
        ),
      );
      testState.updateServer.mockResolvedValue(success());

      await using screen = await renderAction();
      expect(button(screen, "Update")!.disabled).toBe(!allowed);
      await click(screen, "Update");

      expect(testState.updateServer).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it("disables the action once maintenance access is removed", async () => {
    using _state = setup();
    await using screen = await renderAction();
    await act(() => setSession(AsyncResult.success({ ...currentSession, scopes: [] })));
    expect(button(screen, "Update")!.disabled).toBe(true);
    await click(screen, "Update");
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("updates remote desktop apps through the shared update flow", async () => {
    using _state = setup();
    testState.updateServer.mockResolvedValue(success("desktop-app", "0.0.34"));

    await using screen = await renderAction({
      selfUpdate: "desktop-managed",
      desktopAppUpdate: true,
    });
    await click(screen, "Update");

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31", confirmed: false },
    });
    expect(testState.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Test server updated",
      description: "Desktop app relaunched on 0.0.34.",
    });
  });

  it("updates an idle server without asking", async () => {
    using _state = setup();
    registerConfirmDialogHost();
    testState.updateServer.mockResolvedValue(success());

    await using screen = await renderAction();
    await click(screen, "Update");

    expect(readConfirmDialogState().status).toBe("idle");
    expect(testState.updateServer).toHaveBeenCalledTimes(1);
  });

  it.each(["terminal", "failed inspection"] as const)(
    "keeps work running without a dialog host after a %s",
    async (blocker) => {
      using _state = setup();
      testState.hostActivity.mockResolvedValue(
        blocker === "terminal"
          ? AsyncResult.success({ ...idleActivity, terminalsRequiringConfirmation: 1 })
          : AsyncResult.failure(Cause.fail(new Error("Inspection unavailable"))),
      );
      await using screen = await renderAction();
      await click(screen, "Update");
      expect(testState.updateServer).not.toHaveBeenCalled();
      expect(button(screen, "Update")!.disabled).toBe(false);
    },
  );

  it("shows the check on the button and opens a dialog only once work is found", async () => {
    using _state = setup();
    registerConfirmDialogHost();
    const result = AsyncResult.success({ ...idleActivity, activeSessions: 1 });
    const activity = deferred<typeof result>();
    testState.hostActivity.mockReturnValue(activity.promise);
    testState.updateServer.mockResolvedValue(success());

    await using screen = await renderAction();
    await act(async () => {
      button(screen, "Update")!.click();
      button(screen, "Update")!.click();
    });
    expect(readConfirmDialogState().status).toBe("idle");
    expect(button(screen, "Update")!.disabled).toBe(true);
    expect(testState.hostActivity).toHaveBeenCalledTimes(1);

    await act(async () => activity.resolve(result));
    expect(readConfirmDialogState()).toMatchObject({
      status: "confirming",
      message: expect.stringContaining("1 thread will be interrupted."),
    });
    await act(async () => respondToConfirmDialog(true));
    expect(testState.updateServer).toHaveBeenCalledTimes(1);
  });

  it("keeps running work when the user cancels the confirmation", async () => {
    using _state = setup();
    testState.hostActivity.mockResolvedValue(
      AsyncResult.success({ ...idleActivity, activeSessions: 1 }),
    );
    registerConfirmDialogHost();

    await using screen = await renderAction();
    await click(screen, "Update");

    expect(readConfirmDialogState()).toMatchObject({
      message: expect.stringContaining("1 thread will be interrupted."),
      confirmLabel: "Update",
    });
    await act(async () => respondToConfirmDialog(false));
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("updates after the user confirms interrupting running work", async () => {
    using _state = setup();
    testState.hostActivity.mockResolvedValue(
      AsyncResult.success({ ...idleActivity, terminalsRequiringConfirmation: 2 }),
    );
    registerConfirmDialogHost();
    testState.updateServer.mockResolvedValue(success());

    await using screen = await renderAction();
    await click(screen, "Update");
    await act(async () => respondToConfirmDialog(true));

    expect(testState.updateServer).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31", confirmed: true },
    });
  });

  it("asks before updating when activity cannot be checked", async () => {
    using _state = setup();
    testState.hostActivity.mockResolvedValue(AsyncResult.failure(Cause.fail("unavailable")));
    registerConfirmDialogHost();

    await using screen = await renderAction();
    await click(screen, "Update");

    expect(readConfirmDialogState()).toMatchObject({
      message: expect.stringContaining("Could not check the Test server for running work."),
      confirmLabel: "Update",
    });
    await act(async () => respondToConfirmDialog(false));
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("does not request continuation from a server without it", async () => {
    using _state = setup();
    testState.updateServer.mockResolvedValue(success());

    await using screen = await renderAction();
    await click(screen, "Update");

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31", confirmed: false },
    });
  });

  it("requests continuation from a server that supports it", async () => {
    using _state = setup();
    testState.updateServer.mockResolvedValue(success());

    await using screen = await renderAction({ threadContinuation: true });
    await click(screen, "Update");

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31", confirmed: false, continueRunningThreads: true },
    });
  });
});

describe("ServerUpdatesAction", () => {
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

  const mount = (batch = targets) => renderUpdate(<ServerUpdatesAction targets={batch} />);

  it("updates both supported machines with their own continuation support and skips the manual machine", async () => {
    using _state = setup();
    testState.updateServer.mockResolvedValue(success());
    await using screen = await mount();
    await click(screen, "Update all");

    expect(testState.updateServer.mock.calls.map(([target]) => target)).toEqual([
      {
        environmentId: "batch-a",
        input: { targetVersion: "0.0.31", confirmed: false, continueRunningThreads: true },
      },
      { environmentId: "batch-b", input: { targetVersion: "0.0.31", confirmed: false } },
    ]);
    expect(testState.toast.mock.calls.map(([toast]) => toast.title)).toEqual([
      "Laptop updated",
      "Office updated",
    ]);
  });

  it("names a failed machine while letting the other machine complete", async () => {
    using _state = setup();
    testState.updateServer
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Download failed"))))
      .mockResolvedValueOnce(success());
    await using screen = await mount();
    await click(screen, "Update all");

    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(testState.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Laptop update failed",
      description: "Download failed",
    });
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Office updated" }),
    );
    expect(button(screen, "Update all")!.disabled).toBe(false);
  });

  it("asks once for desktop machines and cancels the entire batch", async () => {
    using _state = setup();
    testState.desktopActivity.mockResolvedValue(
      AsyncResult.success([
        { ...idleActivity, isRequestingEnvironment: true },
        { ...idleActivity, isRequestingEnvironment: false, terminalsRequiringConfirmation: 1 },
      ]),
    );
    registerConfirmDialogHost();
    await using screen = await mount(
      targets.map((target, index) =>
        index < 2 ? { ...target, selfUpdate: "desktop-managed", desktopAppUpdate: true } : target,
      ),
    );
    await click(screen, "Update all");
    expect(readConfirmDialogState()).toEqual(
      expect.objectContaining({
        status: "confirming",
        message: expect.stringContaining("Laptop, Office"),
        confirmLabel: "Update",
      }),
    );
    expect(testState.hostActivity).toHaveBeenCalledTimes(2);
    expect(testState.desktopActivity).toHaveBeenCalledTimes(2);
    expect(testState.updateServer).not.toHaveBeenCalled();
    await act(async () => respondToConfirmDialog(false));
    expect(testState.updateServer).not.toHaveBeenCalled();
    expect(button(screen, "Update all")!.disabled).toBe(false);
  });

  it("asks once when work is running on any machine in the batch", async () => {
    using _state = setup();
    testState.hostActivity
      .mockResolvedValueOnce(AsyncResult.success(idleActivity))
      .mockResolvedValueOnce(AsyncResult.success({ ...idleActivity, activeSessions: 2 }));
    registerConfirmDialogHost();
    testState.updateServer.mockResolvedValue(success());
    await using screen = await mount();
    await click(screen, "Update all");

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

describe("OutdatedServerUpdateAction", () => {
  it.each([false, true])(
    "requires explicit consent for unavailable activity (%s)",
    async (consent) => {
      using _state = setup();
      registerConfirmDialogHost();
      testState.updateServer.mockResolvedValue(success());
      await using screen = await renderUpdate(
        <OutdatedServerUpdateAction
          environmentId={"outdated" as EnvironmentId}
          serverLabel="Lab"
          fromVersion="0.0.30"
          targetVersion="0.0.31"
        />,
      );
      await click(screen, "Update");
      expect(readConfirmDialogState()).toMatchObject({
        status: "confirming",
        message: expect.stringContaining("Could not check this outdated server for running work"),
      });
      expect(testState.updateServer).not.toHaveBeenCalled();
      await act(async () => respondToConfirmDialog(consent));
      if (consent) {
        expect(testState.updateServer).toHaveBeenCalledExactlyOnceWith({
          environmentId: "outdated",
          input: { targetVersion: "0.0.31", confirmed: true },
          fromVersion: "0.0.30",
        });
      } else expect(testState.updateServer).not.toHaveBeenCalled();
    },
  );
});
