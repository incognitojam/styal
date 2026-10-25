import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AuthSessionState,
  type DesktopBridge,
  type DesktopHostActivity,
  type DesktopUpdateState,
  type HostActivity,
  type HostActivityThread,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  hostActivity: vi.fn(),
  desktopHostActivity: vi.fn(),
  updateServer: vi.fn(),
  updateProvider: vi.fn(),
  localActivity: vi.fn(),
  install: vi.fn(),
  toast: vi.fn(),
  sessionAtom: null as unknown as Atom.Writable<AsyncResult.AsyncResult<AuthSessionState>>,
  updateAtoms: new Map<string, Atom.Writable<ServerUpdateState>>(),
  providers: new Map<EnvironmentId, ReadonlyArray<ServerProvider>>(),
}));

vi.mock(import("~/env"), () => ({ isElectron: true }));
vi.mock(import("~/state/npmRelease"), async (original) => ({
  ...(await original()),
  useNpmReleasePublished: () => true,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments })) as never,
  useEnvironmentProviders: () => testState.providers,
}));
vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  const { environmentAtomList } = await import("~/state/environmentAtomList");
  const sessionStateAtom = () => testState.sessionAtom;
  return {
    ...actual,
    environmentSession: { ...actual.environmentSession, sessionStateAtom },
    environmentSessionStatesAtom: environmentAtomList("test-update-sessions", sessionStateAtom),
  };
});
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { environmentAtomList } = await import("~/state/environmentAtomList");
  const updateStateAtom = (id: EnvironmentId | null) => testState.updateAtoms.get(id ?? "local")!;
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, updateStateAtom },
    environmentUpdateStatesAtom: environmentAtomList("test-update-states", updateStateAtom),
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { serverEnvironment } = await import("~/state/server");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) => {
      if (command === serverEnvironment.hostActivity) return testState.hostActivity;
      if (command === serverEnvironment.desktopHostActivity) return testState.desktopHostActivity;
      if (command === serverEnvironment.updateProvider) return testState.updateProvider;
      if (command === serverEnvironment.updateServer) return testState.updateServer;
      throw new Error("Unexpected update command");
    }) as never,
  };
});
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } };
});

import {
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
} from "~/confirmDialog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { setUpdateEverythingRun } from "./updateEverythingRun";

const localVersion = "0.0.50";
const downloaded: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  channel: "latest",
  currentVersion: "0.0.49",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: localVersion,
  downloadedVersion: localVersion,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

const environments = [
  { id: "local", label: "This computer", local: true, continues: true },
  { id: "remote-a", label: "Build machine", local: false, continues: true },
  { id: "remote-b", label: "Test machine", local: false, continues: false },
].map(({ id, label, local, continues }) => ({
  environmentId: EnvironmentId.make(id),
  label,
  entry: {
    target: {
      _tag: local ? "PrimaryConnectionTarget" : "BearerConnectionTarget",
      connectionId: id,
    },
  },
  connection: { phase: "connected" },
  serverConfig: {
    environment: {
      environmentId: EnvironmentId.make(id),
      label,
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.49",
      capabilities: {
        repositoryIdentity: true,
        serverSelfUpdate: local ? "desktop-managed" : "boot-service",
        threadRestartContinuation: continues,
      },
    },
    settings: { continueThreadsAfterServerUpdate: continues },
  },
}));

const idle: HostActivity = {
  activeSessions: 0,
  continuableSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
  environmentsUsingDevices: 0,
  threads: [],
};

function thread(
  title: string,
  project: string,
  reasons: HostActivityThread["reasons"],
  continuable = false,
): HostActivityThread {
  return {
    threadId: ThreadId.make(title),
    title,
    project: {
      id: ProjectId.make(project),
      title: project,
      workspaceRoot: `/projects/${project}`,
      faviconPath: null,
      projectIcon: null,
    },
    reasons,
    continuable,
  };
}

const localChecks: ReadonlyArray<DesktopHostActivity | null> = [
  {
    ...idle,
    hostLabel: "Local Linux",
    activeSessions: 1,
    continuableSessions: 1,
    waitingSessions: 1,
    threads: [
      thread("Compile catalog", "Catalog", ["running", "subagent"], true),
      thread("Approve migration", "Catalog", ["approval"]),
    ],
  },
  {
    ...idle,
    hostLabel: "Local subsystem",
    waitingSessions: 1,
    threads: [thread("Check fixtures", "Fixtures", ["input", "command"])],
  },
];

const remoteActivity: HostActivity = {
  ...idle,
  activeSessions: 1,
  continuableSessions: 1,
  waitingSessions: 1,
  threads: [
    thread("Build release", "Release", ["running"], true),
    thread("Review release", "Release", ["waiting"]),
  ],
};

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-build"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-20T10:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    updateCommand: "npm install -g example-provider",
    canUpdate: true,
    checkedAt: "2026-10-20T10:00:00.000Z",
    message: "Update available.",
  },
};

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const updated = () => AsyncResult.success({ method: "boot-service", targetVersion: localVersion });
let root: Root;
let container: HTMLDivElement;
const desktopListeners = new Set<(state: DesktopUpdateState) => void>();

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"][data-open]');
function button(name: string, within: ParentNode = document) {
  const match = [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === name,
  );
  expect(match, `button ${name}`).toBeDefined();
  return match!;
}
const click = (element: HTMLElement) => act(async () => element.click());

async function render() {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ul>
          <SidebarUpdatePill />
        </ul>
      </RegistryContext.Provider>,
    ),
  );
}

async function openConfirmation() {
  await click(container.querySelector<HTMLButtonElement>("button")!);
  expect(dialog()).not.toBeNull();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  testState.hostActivity.mockReset().mockResolvedValue(AsyncResult.success(idle));
  testState.desktopHostActivity
    .mockReset()
    .mockResolvedValue(AsyncResult.success([{ ...idle, isRequestingEnvironment: true }]));
  testState.localActivity.mockReset().mockResolvedValue(localChecks);
  testState.updateServer.mockReset().mockResolvedValue(updated());
  testState.updateProvider.mockReset();
  testState.providers.clear();
  testState.install
    .mockReset()
    .mockResolvedValue({ accepted: true, completed: false, failed: false, state: downloaded });
  testState.sessionAtom = Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(
    AsyncResult.success({
      authenticated: true,
      scopes: ["environment:maintain"],
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["bearer-access-token"],
        sessionCookieName: "t3_session",
        serverUpdateScope: "environment:maintain",
      },
    } satisfies AuthSessionState),
  );
  testState.updateAtoms = new Map(
    environments.map(({ environmentId }) => [
      environmentId,
      Atom.make<ServerUpdateState>({ status: "idle" }),
    ]),
  );
  vi.stubGlobal("desktopBridge", {
    getUpdateState: async () => downloaded,
    onUpdateState: (listener: (state: DesktopUpdateState) => void) => {
      desktopListeners.add(listener);
      return () => desktopListeners.delete(listener);
    },
    getLocalHostActivity: testState.localActivity,
    installUpdate: testState.install,
  } as unknown as DesktopBridge);
  resetConfirmDialogForTests();
  registerConfirmDialogHost();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setUpdateEverythingRun(() => null);
  appAtomRegistry.reset();
  desktopListeners.clear();
  localStorage.clear();
  resetConfirmDialogForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("combined sidebar update", () => {
  it.each(["local", "remote"] as const)(
    "waits for both activity snapshots when %s finishes first",
    async (first) => {
      const local = deferred<ReadonlyArray<DesktopHostActivity | null>>();
      const remote = deferred<AsyncResult.AsyncResult<HostActivity>>();
      testState.localActivity.mockReturnValue(local.promise);
      testState.hostActivity.mockReturnValue(remote.promise);
      await render();
      await openConfirmation();

      expect(testState.localActivity).toHaveBeenCalledTimes(1);
      expect(testState.hostActivity.mock.calls.map(([target]) => target.environmentId)).toEqual([
        "remote-a",
        "remote-b",
      ]);
      expect(dialog()!.textContent).toContain("Checking for running work…");
      expect(button("Update", dialog()!).disabled).toBe(true);
      await click(button("Update", dialog()!));
      expect(testState.updateServer).not.toHaveBeenCalled();

      await act(async () => {
        if (first === "local") local.resolve(localChecks);
        else remote.resolve(AsyncResult.success(remoteActivity));
      });
      expect(button("Update", dialog()!).disabled).toBe(true);
      expect(dialog()!.querySelector('[aria-label="Affected threads"]')).toBeNull();

      await act(async () => {
        local.resolve(localChecks);
        remote.resolve(AsyncResult.success(remoteActivity));
      });
      expect(button("Update", dialog()!).disabled).toBe(false);
      expect(dialog()!.textContent).not.toContain("Checking for running work…");
      const hosts = [...dialog()!.querySelector('[aria-label="Affected threads"]')!.children];
      expect(hosts.map((host) => host.querySelector("h3")?.textContent)).toEqual([
        "Local Linux",
        "Local subsystem",
        "Build machine",
        "Test machine",
      ]);
      const sections = (host: Element, heading: string) =>
        host.querySelector(`[aria-label="${heading}"]`)!.textContent;
      expect(sections(hosts[0]!, "Will continue")).toContain(
        "CatalogCompile catalogRunningSubagent",
      );
      expect(sections(hosts[0]!, "Will be interrupted")).toContain(
        "CatalogApprove migrationNeeds approval",
      );
      expect(hosts[1]!.textContent).toContain(
        "FixturesCheck fixturesNeeds inputBackground command",
      );
      expect(sections(hosts[2]!, "Will continue")).toContain("ReleaseBuild releaseRunning");
      expect(sections(hosts[2]!, "Will be interrupted")).toContain("ReleaseReview releaseWaiting");
      expect(hosts[3]!.querySelector('[aria-label="Will continue"]')).toBeNull();
      expect(sections(hosts[3]!, "Will be interrupted")).toContain("Build releaseRunning");
      expect(dialog()!.textContent).not.toContain("thread will continue after the restart.");
      expect(dialog()!.textContent).not.toContain("threads will be interrupted.");
      expect(testState.install).not.toHaveBeenCalled();
    },
  );

  it.each(["finished", "handed off"] as const)(
    "updates remote machines in parallel and installs immediately after they have %s",
    async (completion) => {
      const remoteA = deferred<ReturnType<typeof updated>>();
      const remoteB = deferred<ReturnType<typeof updated>>();
      testState.updateServer.mockImplementation(({ environmentId }) =>
        environmentId === "remote-a" ? remoteA.promise : remoteB.promise,
      );
      await render();
      await openConfirmation();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await click(button("Update", dialog()!));

      expect(dialog()).toBeNull();
      expect(testState.updateServer.mock.calls.map(([target]) => target)).toEqual([
        {
          environmentId: "remote-a",
          input: { targetVersion: localVersion, continueRunningThreads: true },
        },
        { environmentId: "remote-b", input: { targetVersion: localVersion } },
      ]);
      expect(testState.install).not.toHaveBeenCalled();
      expect(readConfirmDialogState().status).toBe("idle");
      expect(testState.hostActivity).toHaveBeenCalledTimes(2);

      await act(async () => {
        for (const listener of desktopListeners)
          listener({ ...downloaded, downloadedVersion: "0.0.51", availableVersion: "0.0.51" });
      });

      await act(async () => remoteB.resolve(updated()));
      expect(testState.install).not.toHaveBeenCalled();
      await act(async () => {
        if (completion === "finished") remoteA.resolve(updated());
        else
          appAtomRegistry.set(testState.updateAtoms.get("remote-a")!, {
            status: "running",
            stage: "resuming",
            fromVersion: "0.0.49",
            targetVersion: localVersion,
          });
      });
      expect(testState.install).toHaveBeenCalledExactlyOnceWith({ expectedVersion: localVersion });
      expect(container.textContent).toContain("Restarting…");
      expect(testState.toast).not.toHaveBeenCalled();
      expect(testState.localActivity).toHaveBeenCalledTimes(1);
      await act(async () => remoteA.resolve(updated()));
      expect(testState.install).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores canceled and superseded activity checks without reopening or restarting", async () => {
    const stale = deferred<ReadonlyArray<DesktopHostActivity | null>>();
    const current = deferred<ReadonlyArray<DesktopHostActivity | null>>();
    testState.localActivity.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    await render();
    await openConfirmation();
    await click(button("Cancel", dialog()!));
    expect(dialog()).toBeNull();
    await openConfirmation();
    await act(async () => stale.resolve(localChecks));
    expect(button("Update", dialog()!).disabled).toBe(true);
    expect(dialog()!.textContent).not.toContain("Compile catalog");
    await click(button("Cancel", dialog()!));
    await act(async () => current.resolve(localChecks));
    expect(dialog()).toBeNull();
    expect(testState.updateServer).not.toHaveBeenCalled();
    expect(testState.install).not.toHaveBeenCalled();
  });

  it("finishes provider installation before restarting either remote server", async () => {
    const providers =
      deferred<AsyncResult.AsyncResult<{ providers: ReadonlyArray<ServerProvider> }>>();
    testState.providers.set(EnvironmentId.make("remote-a"), [provider]);
    testState.updateProvider.mockReturnValue(providers.promise);
    await render();
    await openConfirmation();
    expect(dialog()!.textContent).toContain("Codex");
    await click(button("Update", dialog()!));
    expect(testState.updateProvider).toHaveBeenCalledExactlyOnceWith({
      environmentId: "remote-a",
      input: { provider: "codex", instanceId: "codex-build" },
    });
    expect(testState.updateServer).not.toHaveBeenCalled();
    expect(testState.install).not.toHaveBeenCalled();
    await act(async () =>
      providers.resolve(
        AsyncResult.success({
          providers: [
            {
              ...provider,
              version: "1.1.0",
              updateState: {
                status: "succeeded",
                startedAt: null,
                finishedAt: null,
                message: null,
                output: null,
              },
            },
          ],
        }),
      ),
    );
    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(testState.install).toHaveBeenCalledExactlyOnceWith({ expectedVersion: localVersion });
    expect(readConfirmDialogState().status).toBe("idle");
    expect(testState.toast).not.toHaveBeenCalled();
  });

  it("falls back to the connected local host on legacy bridges and keeps installation guarded", async () => {
    delete window.desktopBridge!.getLocalHostActivity;
    testState.hostActivity.mockResolvedValue(AsyncResult.success(remoteActivity));
    await render();
    await openConfirmation();
    expect(
      testState.hostActivity.mock.calls.map(([target]) => target.environmentId).toSorted(),
    ).toEqual(["local", "remote-a", "remote-b"]);
    expect(dialog()!.textContent).toContain("Build release");
    await click(button("Update", dialog()!));
    expect(testState.install).toHaveBeenCalledExactlyOnceWith();
    expect(readConfirmDialogState().status).toBe("idle");
  });

  it("warns when local inspection fails while preserving the inspected remote thread details", async () => {
    testState.localActivity.mockRejectedValue(new Error("Local inspection unavailable"));
    testState.hostActivity.mockImplementation(({ environmentId }) =>
      Promise.resolve(
        environmentId === "remote-a"
          ? AsyncResult.success(remoteActivity)
          : AsyncResult.failure(Cause.fail(new Error("Remote inspection unavailable"))),
      ),
    );
    await render();
    await openConfirmation();
    expect(dialog()!.textContent).toContain("Could not check this app for running work.");
    expect(dialog()!.textContent).toContain("Could not check Test machine for running work.");
    expect(dialog()!.textContent).toContain("Build releaseRunning");
    expect(button("Update", dialog()!).disabled).toBe(false);
    expect(testState.install).not.toHaveBeenCalled();
    await click(button("Cancel", dialog()!));
    expect(testState.updateServer).not.toHaveBeenCalled();
    expect(testState.install).not.toHaveBeenCalled();
  });
});
