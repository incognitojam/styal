import { RegistryContext } from "@effect/atom-react";
import { AuthSessionState, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  hostActivity: vi.fn(),
  desktopHostActivity: vi.fn(),
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
    useAtomCommand: ((command: unknown) =>
      command === serverEnvironment.hostActivity
        ? testState.hostActivity
        : command === serverEnvironment.desktopHostActivity
          ? testState.desktopHostActivity
          : testState.updateServer) as never,
  };
});
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } };
});

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "~/confirmDialog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  ServerUpdateAction,
  ServerUpdateProgress,
  ServerUpdatesAction,
  type ServerUpdateTarget,
} from "./ServerUpdateAction";

import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";

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

let root: Root;
let container: HTMLDivElement;
let sessionAtom: Atom.Writable<SessionResult>;

function setSession(session: SessionResult) {
  appAtomRegistry.set(sessionAtom, session);
}

async function render(element: ReactNode) {
  await act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>{element}</RegistryContext.Provider>,
    ),
  );
}

function button(name?: string) {
  const buttons = [...container.querySelectorAll("button")];
  return name === undefined
    ? buttons[0]
    : buttons.find((element) => element.textContent?.trim() === name);
}

async function click(name?: string) {
  await act(async () => button(name)!.click());
}

async function renderAction(
  props: Partial<Parameters<typeof ServerUpdateAction>[0]> = {},
): Promise<void> {
  await render(
    <ServerUpdateAction
      environmentId={"env-test" as EnvironmentId}
      serverLabel="Test server"
      selfUpdate="boot-service"
      targetVersion="0.0.31"
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.updateServer.mockReset();
  testState.hostActivity.mockReset();
  testState.desktopHostActivity.mockReset();
  testState.desktopHostActivity.mockResolvedValue(
    AsyncResult.success([{ ...idleActivity, isRequestingEnvironment: true }]),
  );
  testState.hostActivity.mockResolvedValue(AsyncResult.success(idleActivity));
  testState.toast.mockReset();
  testState.copy.mockReset();
  sessionAtom = Atom.make<SessionResult>(AsyncResult.success(currentSession));
  testState.sessionAtom = sessionAtom;
  resetConfirmDialogForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetConfirmDialogForTests();
  vi.unstubAllGlobals();
});

describe("ServerUpdateAction", () => {
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

      await renderAction();
      expect(button("Update")!.disabled).toBe(!allowed);
      await click("Update");

      expect(testState.updateServer).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it("keeps a known grant usable while the session refreshes", async () => {
    setSession(AsyncResult.waiting(AsyncResult.success(currentSession)));
    testState.updateServer.mockResolvedValue(success());

    await renderAction();
    await click("Update");

    expect(testState.updateServer).toHaveBeenCalledOnce();
  });

  it("does not dispatch an update after maintenance access is removed", async () => {
    await renderAction();
    await act(() => setSession(AsyncResult.success({ ...currentSession, scopes: [] })));
    expect(button("Update")!.disabled).toBe(true);
    await click("Update");
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("reports success only after the shared update flow reconnects", async () => {
    testState.updateServer.mockResolvedValue(success());

    await renderAction();
    await click("Update");

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
          finishUpdate = () => resolve(success());
        }),
    );

    await renderAction();
    await act(async () => {
      button("Update")!.click();
      button("Update")!.click();
    });

    expect(testState.updateServer).toHaveBeenCalledTimes(1);
    await act(async () => finishUpdate?.());
    expect(testState.toast).toHaveBeenCalledTimes(1);
  });

  it("quietly releases the action when the operation is interrupted", async () => {
    testState.updateServer.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));

    await renderAction();
    await click("Update");

    expect(testState.toast).not.toHaveBeenCalled();
  });

  it("keeps the manual instruction for desktop servers without remote update support", async () => {
    await renderAction({ selfUpdate: "desktop-managed" });

    expect(container.textContent).toBe(
      "Update the desktop app on that machine to update this server.",
    );
    expect(button()).toBeUndefined();
  });

  it("updates remote desktop apps through the shared update flow", async () => {
    testState.updateServer.mockResolvedValue(success("desktop-app", "0.0.34"));

    await renderAction({ selfUpdate: "desktop-managed", desktopAppUpdate: true });
    await click("Update");

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
    testState.updateServer.mockResolvedValue(success());

    await renderAction();
    await click("Update");

    expect(readConfirmDialogState().status).toBe("idle");
    expect(testState.updateServer).toHaveBeenCalledTimes(1);
  });

  it("opens immediately and prevents updates until running work has been checked", async () => {
    registerConfirmDialogHost();
    const result = AsyncResult.success({ ...idleActivity, activeSessions: 1 });
    const activity = deferred<typeof result>();
    testState.hostActivity.mockReturnValue(activity.promise);
    testState.updateServer.mockResolvedValue(success());

    await renderAction();
    await act(async () => {
      button("Update")!.click();
      button("Update")!.click();
    });
    expect(readConfirmDialogState()).toMatchObject({
      status: "confirming",
      loading: true,
      message: "Update the Test server?\nChecking for running work…",
    });
    expect(testState.hostActivity).toHaveBeenCalledTimes(1);
    await act(async () => respondToConfirmDialog(true));
    expect(testState.updateServer).not.toHaveBeenCalled();

    await act(async () => activity.resolve(result));
    expect(readConfirmDialogState()).toMatchObject({
      status: "confirming",
      message: expect.stringContaining("1 thread will be interrupted."),
    });
    expect(readConfirmDialogState()).not.toHaveProperty("loading");
    await act(async () => respondToConfirmDialog(true));
    expect(testState.updateServer).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending check immediately and ignores its result after a retry", async () => {
    registerConfirmDialogHost();
    const result = AsyncResult.success(idleActivity);
    const activity = deferred<typeof result>();
    testState.hostActivity
      .mockReturnValueOnce(activity.promise)
      .mockResolvedValue(AsyncResult.success({ ...idleActivity, activeSessions: 2 }));

    await renderAction();
    await click("Update");
    await act(async () => respondToConfirmDialog(false));
    completeConfirmDialogClose();
    expect(readConfirmDialogState().status).toBe("idle");

    await click("Update");
    await act(async () => activity.resolve(result));
    expect(readConfirmDialogState()).toMatchObject({
      status: "confirming",
      message: expect.stringContaining("2 threads will be interrupted."),
    });
    expect(testState.updateServer).not.toHaveBeenCalled();
    await act(async () => respondToConfirmDialog(false));
  });

  it("keeps running work when the user cancels the confirmation", async () => {
    testState.hostActivity.mockResolvedValue(
      AsyncResult.success({ ...idleActivity, activeSessions: 1 }),
    );
    registerConfirmDialogHost();

    await renderAction();
    await click("Update");

    expect(readConfirmDialogState()).toMatchObject({
      message: expect.stringContaining("1 thread will be interrupted."),
      confirmLabel: "Update",
    });
    await act(async () => respondToConfirmDialog(false));
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("updates after the user confirms interrupting running work", async () => {
    testState.hostActivity.mockResolvedValue(
      AsyncResult.success({ ...idleActivity, terminalsRequiringConfirmation: 2 }),
    );
    registerConfirmDialogHost();
    testState.updateServer.mockResolvedValue(success());

    await renderAction();
    await click("Update");
    await act(async () => respondToConfirmDialog(true));

    expect(testState.updateServer).toHaveBeenCalledTimes(1);
  });

  it("asks before updating when activity cannot be checked", async () => {
    testState.hostActivity.mockResolvedValue(AsyncResult.failure(Cause.fail("unavailable")));
    registerConfirmDialogHost();

    await renderAction();
    await click("Update");

    expect(readConfirmDialogState()).toMatchObject({
      message: expect.stringContaining("Could not check the Test server for running work."),
      confirmLabel: "Update",
    });
    await act(async () => respondToConfirmDialog(false));
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("does not request continuation from a server without it", async () => {
    testState.updateServer.mockResolvedValue(success());

    await renderAction();
    await click("Update");

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
  });

  it("requests continuation from a server that supports it", async () => {
    testState.updateServer.mockResolvedValue(success());

    await renderAction({ threadContinuation: true });
    await click("Update");

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31", continueRunningThreads: true },
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

  const mount = (batch = targets) => render(<ServerUpdatesAction targets={batch} />);

  it("updates both supported machines with their own continuation support and skips the manual machine", async () => {
    testState.updateServer.mockResolvedValue(success());
    await mount();
    await click("Update all");

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
      .mockResolvedValueOnce(success());
    await mount();
    await click("Update all");

    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(testState.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Laptop update failed",
      description: "Download failed",
    });
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Office updated" }),
    );
    expect(button("Update all")!.disabled).toBe(false);
  });

  it("starts each machine once when double-clicked and disables the action until both finish", async () => {
    const completions: Array<() => void> = [];
    testState.updateServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          completions.push(() => resolve(success()));
        }),
    );
    await mount();
    await act(async () => {
      button("Update all")!.click();
      button("Update all")!.click();
    });
    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(button("Update all")!.disabled).toBe(true);
    await act(async () => completions[0]!());
    expect(button("Update all")!.disabled).toBe(true);
    await act(async () => completions[1]!());
    expect(button("Update all")!.disabled).toBe(false);
    expect(testState.toast).toHaveBeenCalledTimes(2);
  });

  it("asks once for desktop machines and cancels the entire batch", async () => {
    registerConfirmDialogHost();
    await mount(
      targets.map((target, index) =>
        index < 2 ? { ...target, selfUpdate: "desktop-managed", desktopAppUpdate: true } : target,
      ),
    );
    await click("Update all");
    expect(readConfirmDialogState()).toEqual(
      expect.objectContaining({
        status: "confirming",
        message: expect.stringContaining("Laptop, Office"),
        confirmLabel: "Update",
      }),
    );
    expect(testState.updateServer).not.toHaveBeenCalled();
    await act(async () => respondToConfirmDialog(false));
    expect(testState.updateServer).not.toHaveBeenCalled();
    expect(button("Update all")!.disabled).toBe(false);
  });

  it("asks once when work is running on any machine in the batch", async () => {
    testState.hostActivity
      .mockResolvedValueOnce(AsyncResult.success(idleActivity))
      .mockResolvedValueOnce(AsyncResult.success({ ...idleActivity, activeSessions: 2 }));
    registerConfirmDialogHost();
    testState.updateServer.mockResolvedValue(success());
    await mount();
    await click("Update all");

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
  it("shows one calm status for the restart wait", async () => {
    await render(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "resuming",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );
    expect(container.textContent).toBe("Restarting…");
  });

  it("folds the sub-second installing handoff into the download phase", async () => {
    await render(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );
    expect(container.textContent).toBe("Downloading…");
  });

  it("keeps the failure visible as an alert with its error", async () => {
    await render(
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
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "The package could not be verified.",
    );
  });
});

describe("server updates from the environment selector", () => {
  const localId = "env-test" as EnvironmentId;
  const otherId = "update-server" as EnvironmentId;
  const availableEnvironments = [
    { environmentId: localId, label: "Build box", isPrimary: true },
    { environmentId: otherId, label: "Other machine", isPrimary: false },
  ].map((environment) => ({ ...environment, projectId: null, machine: "server" as const }));
  const serverUpdate = {
    environmentId: localId,
    serverLabel: "Build box",
    serverVersion: "0.0.30",
    targetVersion: "0.0.31",
    selfUpdate: "desktop-managed",
    desktopAppUpdate: true,
  } satisfies ServerUpdateTarget & { serverVersion: string };

  it("confirms a locked chip update and honors cancellation before updating", async () => {
    registerConfirmDialogHost();
    testState.updateServer.mockResolvedValue(success("desktop-app"));
    await render(
      <BranchToolbarEnvironmentSelector
        environmentId={localId}
        availableEnvironments={availableEnvironments}
        envLocked
        serverUpdate={serverUpdate}
      />,
    );
    const chip = page.getByRole("button", { name: /Build box|Update/ });
    await userEvent.click(chip);
    expect(readConfirmDialogState()).toMatchObject({
      status: "confirming",
      message: expect.stringContaining("Build box"),
    });
    expect(testState.updateServer).not.toHaveBeenCalled();
    await act(async () => {
      respondToConfirmDialog(false);
      completeConfirmDialogClose();
    });
    expect(testState.updateServer).not.toHaveBeenCalled();
    await userEvent.click(chip);
    await act(async () => respondToConfirmDialog(true));
    expect(testState.updateServer).toHaveBeenCalledExactlyOnceWith({
      environmentId: localId,
      input: { targetVersion: "0.0.31" },
    });
  });

  it("opens update instructions from the picker without switching machines and still selects an action-like environment ID", async () => {
    const update = { ...serverUpdate, selfUpdate: null, installation: { kind: "npx" } } as const;
    function Picker() {
      const [environmentId, setEnvironmentId] = useState(localId);
      return (
        <BranchToolbarEnvironmentSelector
          environmentId={environmentId}
          availableEnvironments={availableEnvironments}
          envLocked={false}
          onEnvironmentChange={setEnvironmentId}
          serverUpdate={environmentId === localId ? update : null}
        />
      );
    }
    await render(<Picker />);
    const picker = page.getByRole("combobox", { name: "Run on" });
    await userEvent.click(picker);
    await expect.element(page.getByRole("option", { name: "Other machine" })).toBeVisible();
    await userEvent.click(page.getByRole("option", { name: /Update instructions for Build box/ }));
    await expect.element(page.getByRole("dialog", { name: "Update Build box" })).toBeVisible();
    expect(testState.copy).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Copy start command" }));
    expect(testState.copy).toHaveBeenCalledExactlyOnceWith(
      "npx @styal/cli@0.0.31 serve",
      expect.anything(),
    );
    expect(testState.updateServer).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(picker).toHaveTextContent("Build box");
    await userEvent.click(picker);
    await expect
      .element(page.getByRole("option", { name: "Build box", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    await userEvent.click(page.getByRole("option", { name: "Other machine" }));
    await expect.element(picker).toHaveTextContent("Other machine");
    expect(testState.copy).toHaveBeenCalledTimes(1);
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("explains an unsupported desktop update in the picker without offering a runnable action", async () => {
    registerConfirmDialogHost();
    await render(
      <BranchToolbarEnvironmentSelector
        environmentId={localId}
        availableEnvironments={availableEnvironments}
        envLocked={false}
        onEnvironmentChange={vi.fn()}
        serverUpdate={{ ...serverUpdate, desktopAppUpdate: false }}
      />,
    );
    await userEvent.click(page.getByRole("combobox", { name: "Run on" }));
    const instruction = page.getByRole("option", { name: /Update the desktop app/ });
    await expect.element(instruction).toBeVisible();
    await expect.element(instruction).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(instruction, { force: true });
    expect(readConfirmDialogState().status).toBe("idle");
    expect(testState.updateServer).not.toHaveBeenCalled();
    expect(testState.copy).not.toHaveBeenCalled();
  });
});
