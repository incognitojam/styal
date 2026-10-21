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
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, stubGlobal, type Screen } from "../../../test/render";

const testState = vi.hoisted(() => ({
  hostActivity: vi.fn(),
  desktopActivity: vi.fn(),
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
      if (command === serverEnvironment.desktopHostActivity) return testState.desktopActivity;
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
  subscribeConfirmDialog,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
  completeConfirmDialogClose,
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

const resumableActivity: HostActivity = {
  ...idle,
  activeSessions: 1,
  continuableSessions: 1,
  threads: [thread("Prepare release", "Release", ["running"], true)],
};
const safeLocalChecks: ReadonlyArray<DesktopHostActivity> = [
  { ...resumableActivity, hostLabel: "Local Linux" },
  { ...idle, hostLabel: "Local subsystem" },
];

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
const desktopListeners = new Set<(state: DesktopUpdateState) => void>();

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"][data-open]');
function button(name: string, within: ParentNode = document) {
  const match = [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === name,
  );
  expect(match, `button ${name}`).toBeDefined();
  return match!;
}
const click = (element: HTMLElement) => act(() => element.click());

function renderPill() {
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ul>
        <SidebarUpdatePill />
      </ul>
    </RegistryContext.Provider>,
  );
}

async function openConfirmation(screen: Screen) {
  await click(screen.container.querySelector<HTMLButtonElement>("button")!);
  expect(dialog()).not.toBeNull();
}

function setup() {
  using stack = new DisposableStack();
  vi.clearAllMocks();
  testState.hostActivity.mockReset().mockResolvedValue(AsyncResult.success(idle));
  testState.desktopActivity.mockReset().mockResolvedValue(AsyncResult.success([idle]));
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
  stack.use(
    stubGlobal("desktopBridge", {
      getLocalEnvironmentBootstraps: () => [],
      getUpdateState: async () => downloaded,
      onUpdateState: (listener: (state: DesktopUpdateState) => void) => {
        desktopListeners.add(listener);
        return () => desktopListeners.delete(listener);
      },
      getLocalHostActivity: testState.localActivity,
      installUpdate: testState.install,
    } as unknown as DesktopBridge),
  );
  resetConfirmDialogForTests();
  registerConfirmDialogHost();
  stack.defer(() => {
    setUpdateEverythingRun(() => null);
    appAtomRegistry.reset();
    desktopListeners.clear();
    localStorage.clear();
    resetConfirmDialogForTests();
  });
  return stack.move();
}

describe("combined sidebar update", () => {
  it("keeps a safe activity check after provider installation silent", async () => {
    using _setup = setup();
    const providers =
      deferred<AsyncResult.AsyncResult<{ providers: ReadonlyArray<ServerProvider> }>>();
    const recheck = deferred<AsyncResult.AsyncResult<HostActivity>>();
    testState.providers.set(EnvironmentId.make("remote-a"), [provider]);
    testState.updateProvider.mockReturnValue(providers.promise);
    testState.localActivity.mockResolvedValue(safeLocalChecks);
    const presentations: Array<ReturnType<typeof readConfirmDialogState>> = [];
    const unsubscribe = subscribeConfirmDialog(() => presentations.push(readConfirmDialogState()));
    try {
      await using screen = await renderPill();
      await click(screen.container.querySelector<HTMLButtonElement>("button")!);
      testState.hostActivity.mockReturnValue(recheck.promise);
      await act(() => providers.resolve(AsyncResult.success({ providers: [] })));
      expect(readConfirmDialogState().status).toBe("idle");
      expect(testState.updateServer).not.toHaveBeenCalled();

      await act(() => recheck.resolve(AsyncResult.success(idle)));
      expect(readConfirmDialogState().status).toBe("idle");
      expect(testState.updateServer).toHaveBeenCalledTimes(2);
      expect(presentations).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("does not extend consent to servers that changed while the dialog was open", async () => {
    using _setup = setup();
    testState.hostActivity.mockResolvedValue(
      AsyncResult.success({ ...idle, terminalsRequiringConfirmation: 1 }),
    );
    await using screen = await renderPill();
    await openConfirmation(screen);
    // Another client starts updating the test machine, which drops it from this run.
    await act(() =>
      appAtomRegistry.set(testState.updateAtoms.get("remote-b")!, {
        status: "running",
        stage: "resuming",
        fromVersion: "0.0.49",
        targetVersion: localVersion,
      }),
    );
    expect(readConfirmDialogState().status).toBe("idle");
    await click(button("Update", dialog()!));
    // The remaining server is checked again and its terminal asks before any restart.
    await vi.waitFor(() =>
      expect(readConfirmDialogState()).toMatchObject({ status: "confirming" }),
    );
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it.each(["local", "remote"] as const)(
    "automatically updates safe mixed hosts after %s inspection finishes first",
    async (first) => {
      using _setup = setup();
      const local = deferred<ReadonlyArray<DesktopHostActivity | null>>();
      const remote = deferred<AsyncResult.AsyncResult<HostActivity>>();
      const remoteA = deferred<ReturnType<typeof updated>>();
      const remoteB = deferred<ReturnType<typeof updated>>();
      testState.localActivity.mockReturnValue(local.promise);
      testState.hostActivity.mockImplementation(({ environmentId }) =>
        environmentId === "remote-a" ? remote.promise : Promise.resolve(AsyncResult.success(idle)),
      );
      testState.updateServer.mockImplementation(({ environmentId }) =>
        environmentId === "remote-a" ? remoteA.promise : remoteB.promise,
      );
      await using screen = await renderPill();
      await click(screen.container.querySelector<HTMLButtonElement>("button")!);

      await act(() => {
        if (first === "local") local.resolve(safeLocalChecks);
        else remote.resolve(AsyncResult.success(resumableActivity));
      });
      expect(dialog()).toBeNull();
      expect(testState.updateServer).not.toHaveBeenCalled();
      expect(testState.install).not.toHaveBeenCalled();

      await act(() => {
        local.resolve(safeLocalChecks);
        remote.resolve(AsyncResult.success(resumableActivity));
      });
      expect(dialog()).toBeNull();
      expect(readConfirmDialogState().status).toBe("idle");
      expect(testState.updateServer.mock.calls.map(([target]) => target)).toEqual([
        {
          environmentId: "remote-a",
          input: { targetVersion: localVersion, continueRunningThreads: true, confirmed: false },
        },
        { environmentId: "remote-b", input: { targetVersion: localVersion, confirmed: false } },
      ]);
      expect(testState.install).not.toHaveBeenCalled();

      await act(() => remoteB.resolve(updated()));
      expect(testState.install).not.toHaveBeenCalled();
      await act(() => remoteA.resolve(updated()));
      expect(testState.install).toHaveBeenCalledExactlyOnceWith({
        expectedVersion: localVersion,
        confirmed: false,
      });
      expect(testState.localActivity).toHaveBeenCalledTimes(1);
      expect(testState.hostActivity.mock.calls.map(([target]) => target.environmentId)).toEqual([
        "remote-a",
        "remote-b",
        "remote-a",
        "remote-b",
      ]);
      expect(screen.container.textContent).toContain("Restarting…");
      expect(screen.container.textContent).not.toContain("Restart in");
      expect(testState.toast).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "a waiting request", blocker: { ...idle, waitingSessions: 1 }, location: "local" },
    { name: "unknown host activity", blocker: null, location: "remote" },
  ] as const)(
    "requires consent for $name on a $location host despite other resumable work",
    async ({ blocker: blocked, location }) => {
      using _setup = setup();
      testState.localActivity.mockResolvedValue(location === "local" ? [blocked] : safeLocalChecks);
      testState.hostActivity.mockImplementation(({ environmentId }) =>
        Promise.resolve(
          environmentId === "remote-a"
            ? AsyncResult.success(resumableActivity)
            : location !== "remote"
              ? AsyncResult.success(idle)
              : blocked === null
                ? AsyncResult.failure(Cause.fail(new Error("Inspection unavailable")))
                : AsyncResult.success(blocked),
        ),
      );
      await using screen = await renderPill();
      await openConfirmation(screen);
      expect(dialog()!.textContent).not.toContain("Checking for running work…");
      expect(button("Update", dialog()!).disabled).toBe(false);
      expect(dialog()!.querySelector('[aria-label="Will continue"]')!.textContent).toContain(
        "Prepare release",
      );
      expect(testState.updateServer).not.toHaveBeenCalled();
      expect(testState.install).not.toHaveBeenCalled();
      await click(button("Cancel", dialog()!));
      expect(dialog()).toBeNull();
      expect(testState.updateServer).not.toHaveBeenCalled();
      expect(testState.install).not.toHaveBeenCalled();
    },
  );

  it("retains a safe remote host's continuing rows when another host needs consent", async () => {
    using _setup = setup();
    testState.localActivity.mockResolvedValue(safeLocalChecks);
    testState.hostActivity.mockImplementation(({ environmentId }) =>
      Promise.resolve(
        AsyncResult.success(
          environmentId === "remote-a"
            ? resumableActivity
            : {
                ...idle,
                waitingSessions: 1,
                threads: [thread("Approve deployment", "Deployment", ["approval"])],
              },
        ),
      ),
    );
    await using screen = await renderPill();
    await openConfirmation(screen);
    const hosts = [...dialog()!.querySelector('[aria-label="Affected threads"]')!.children];
    expect(hosts.map((host) => host.querySelector("h3")?.textContent)).toEqual([
      "Local Linux",
      "Build machine",
      "Test machine",
    ]);
    expect(hosts[1]!.querySelector('[aria-label="Will continue"]')!.textContent).toContain(
      "Prepare releaseRunning",
    );
    expect(hosts[1]!.querySelector('[aria-label="Will be interrupted"]')).toBeNull();
    expect(hosts[2]!.querySelector('[aria-label="Will be interrupted"]')!.textContent).toContain(
      "Approve deploymentNeeds approval",
    );
    expect(testState.hostActivity).toHaveBeenCalledTimes(2);
    expect(testState.install).not.toHaveBeenCalled();
    await click(button("Update", dialog()!));
    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(testState.install).toHaveBeenCalledExactlyOnceWith({
      expectedVersion: localVersion,
      confirmed: true,
    });
    expect(readConfirmDialogState().status).toBe("idle");
  });

  it.each(["local", "remote"] as const)(
    "waits for both activity snapshots when %s finishes first",
    async (first) => {
      using _setup = setup();
      const local = deferred<ReadonlyArray<DesktopHostActivity | null>>();
      const remote = deferred<AsyncResult.AsyncResult<HostActivity>>();
      testState.localActivity.mockReturnValue(local.promise);
      testState.hostActivity.mockReturnValue(remote.promise);
      await using screen = await renderPill();
      const pill = screen.container.querySelector<HTMLButtonElement>("button")!;
      await click(pill);

      expect(testState.localActivity).toHaveBeenCalledTimes(1);
      expect(testState.hostActivity.mock.calls.map(([target]) => target.environmentId)).toEqual([
        "remote-a",
        "remote-b",
      ]);
      expect(dialog()).toBeNull();
      expect(pill.getAttribute("aria-disabled")).toBe("true");

      await act(() => {
        if (first === "local") local.resolve(localChecks);
        else remote.resolve(AsyncResult.success(remoteActivity));
      });
      expect(dialog()).toBeNull();

      await act(() => {
        local.resolve(localChecks);
        remote.resolve(AsyncResult.success(remoteActivity));
      });
      expect(button("Update", dialog()!).disabled).toBe(false);
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
      expect(dialog()!.textContent).not.toMatch(/\d+ threads? will (be interrupted|continue)/);
      expect(testState.install).not.toHaveBeenCalled();
    },
  );

  it.each(["finished", "handed off"] as const)(
    "updates remote machines in parallel and installs immediately after they have %s",
    async (completion) => {
      using _setup = setup();
      const remoteA = deferred<ReturnType<typeof updated>>();
      const remoteB = deferred<ReturnType<typeof updated>>();
      testState.updateServer.mockImplementation(({ environmentId }) =>
        environmentId === "remote-a" ? remoteA.promise : remoteB.promise,
      );
      await using screen = await renderPill();
      await openConfirmation(screen);
      using _timers = fakeTimers();
      await click(button("Update", dialog()!));

      expect(dialog()).toBeNull();
      expect(testState.updateServer.mock.calls.map(([target]) => target)).toEqual([
        {
          environmentId: "remote-a",
          input: { targetVersion: localVersion, continueRunningThreads: true, confirmed: true },
        },
        { environmentId: "remote-b", input: { targetVersion: localVersion, confirmed: true } },
      ]);
      expect(testState.install).not.toHaveBeenCalled();
      expect(readConfirmDialogState().status).toBe("idle");
      expect(testState.hostActivity).toHaveBeenCalledTimes(2);

      await act(() => {
        for (const listener of desktopListeners)
          listener({ ...downloaded, downloadedVersion: "0.0.51", availableVersion: "0.0.51" });
      });

      await act(() => remoteB.resolve(updated()));
      expect(testState.install).not.toHaveBeenCalled();
      await act(() => {
        if (completion === "finished") remoteA.resolve(updated());
        else
          appAtomRegistry.set(testState.updateAtoms.get("remote-a")!, {
            status: "running",
            stage: "resuming",
            fromVersion: "0.0.49",
            targetVersion: localVersion,
          });
      });
      expect(testState.install).toHaveBeenCalledExactlyOnceWith({
        expectedVersion: localVersion,
        confirmed: true,
      });
      expect(screen.container.textContent).toContain("Restarting…");
      expect(testState.toast).not.toHaveBeenCalled();
      expect(testState.localActivity).toHaveBeenCalledTimes(1);
      await act(() => remoteA.resolve(updated()));
      expect(testState.install).toHaveBeenCalledTimes(1);
    },
  );

  it("finishes provider installation before restarting either remote server", async () => {
    using _setup = setup();
    const providers =
      deferred<AsyncResult.AsyncResult<{ providers: ReadonlyArray<ServerProvider> }>>();
    testState.providers.set(EnvironmentId.make("remote-a"), [provider]);
    testState.updateProvider.mockReturnValue(providers.promise);
    await using screen = await renderPill();
    await openConfirmation(screen);
    expect(dialog()!.textContent).toContain("Codex");
    await click(button("Update", dialog()!));
    expect(testState.updateProvider).toHaveBeenCalledExactlyOnceWith({
      environmentId: "remote-a",
      input: { provider: "codex", instanceId: "codex-build" },
    });
    expect(testState.updateServer).not.toHaveBeenCalled();
    expect(testState.install).not.toHaveBeenCalled();
    await act(() =>
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
    expect(testState.install).toHaveBeenCalledExactlyOnceWith({
      expectedVersion: localVersion,
      confirmed: true,
    });
    expect(readConfirmDialogState().status).toBe("idle");
    expect(testState.toast).not.toHaveBeenCalled();
  });

  it.each(["terminal", "failed inspection"] as const)(
    "rechecks unconfirmed hosts after provider installation and prompts for a new %s",
    async (blocker) => {
      using _setup = setup();
      const providers =
        deferred<AsyncResult.AsyncResult<{ providers: ReadonlyArray<ServerProvider> }>>();
      testState.providers.set(EnvironmentId.make("remote-a"), [provider]);
      testState.updateProvider.mockReturnValue(providers.promise);
      testState.localActivity.mockResolvedValue(safeLocalChecks);
      await using screen = await renderPill();
      await click(screen.container.querySelector<HTMLButtonElement>("button")!);
      expect(dialog()).toBeNull();
      expect(testState.updateProvider).toHaveBeenCalledTimes(1);
      expect(testState.updateServer).not.toHaveBeenCalled();

      testState.hostActivity.mockImplementation(({ environmentId }) =>
        Promise.resolve(
          environmentId !== "remote-a"
            ? AsyncResult.success(idle)
            : blocker === "terminal"
              ? AsyncResult.success({ ...idle, terminalsRequiringConfirmation: 1 })
              : AsyncResult.failure(Cause.fail(new Error("Inspection unavailable"))),
        ),
      );
      await act(() => providers.resolve(AsyncResult.success({ providers: [] })));
      const confirmation = readConfirmDialogState();
      expect(confirmation.status).toBe("confirming");
      expect(confirmation.status !== "idle" && confirmation.message).toContain(
        blocker === "terminal" ? "terminal" : "Could not check",
      );
      expect(testState.updateServer).not.toHaveBeenCalled();
      expect(testState.install).not.toHaveBeenCalled();
      expect(testState.hostActivity).toHaveBeenCalledTimes(4);

      await act(() => {
        respondToConfirmDialog(true);
        completeConfirmDialogClose();
      });
      expect(testState.updateServer).toHaveBeenCalledTimes(2);
      expect(testState.install).toHaveBeenCalledExactlyOnceWith({
        expectedVersion: localVersion,
        confirmed: false,
      });
    },
  );

  it("falls back to the connected local host on legacy bridges and keeps installation guarded", async () => {
    using _setup = setup();
    delete window.desktopBridge!.getLocalHostActivity;
    testState.hostActivity.mockResolvedValue(AsyncResult.success(remoteActivity));
    await using screen = await renderPill();
    await openConfirmation(screen);
    expect(
      testState.hostActivity.mock.calls.map(([target]) => target.environmentId).toSorted(),
    ).toEqual(["local", "remote-a", "remote-b"]);
    expect(dialog()!.textContent).toContain("Build release");
    await click(button("Update", dialog()!));
    expect(testState.install).toHaveBeenCalledExactlyOnceWith();
    expect(readConfirmDialogState().status).toBe("idle");
  });

  it("warns when local inspection fails while preserving the inspected remote thread details", async () => {
    using _setup = setup();
    testState.localActivity.mockRejectedValue(new Error("Local inspection unavailable"));
    testState.hostActivity.mockImplementation(({ environmentId }) =>
      Promise.resolve(
        environmentId === "remote-a"
          ? AsyncResult.success(remoteActivity)
          : AsyncResult.failure(Cause.fail(new Error("Remote inspection unavailable"))),
      ),
    );
    await using screen = await renderPill();
    await openConfirmation(screen);
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
