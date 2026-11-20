import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AgentSessionProjectCandidate,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type EnvironmentCloudLinkStateResult,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../../test/render";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
type Project = { id: ProjectId; environmentId: EnvironmentId; workspaceRoot: string };
type Computer = {
  environmentId: EnvironmentId;
  label: string;
  serverConfig?: { settings: typeof DEFAULT_UNIFIED_SETTINGS };
  displayUrl: string | null;
  connection: { phase: string; error: string | null };
  entry: { enabled: boolean; target: { _tag: string }; alternateRoutes: [] };
};
type T3Summary = {
  projects: number;
  threads: number;
  preferences: number;
  preferenceChanges: number;
  previewPending: boolean;
  projectsAvailable: number;
  preferencesSelected: boolean;
};
type CreateProjectInput = {
  environmentId: EnvironmentId;
  input: { projectId: ProjectId; workspaceRoot: string };
};
const state = vi.hoisted(() => ({
  computers: [] as Computer[],
  primaryId: "primary" as string | null,
  sessions: new Map<string, unknown>(),
  projects: null as unknown,
  providers: null as unknown,
  config: null as unknown,
  candidates: null as unknown,
  createProject: vi.fn(),
  importThreads: vi.fn(),
  refreshProviders: vi.fn(),
  updateSettings: vi.fn(),
  t3Summary: null as unknown,
  t3Run: vi.fn(),
  t3SelectProjects: vi.fn(),
  t3SelectPreferences: vi.fn(),
  completeOnboarding: vi.fn(),
  onDone: vi.fn(),
  scan: vi.fn(),
  refreshScan: vi.fn(),
  waitForProject: vi.fn(),
  cloud: false,
  auth: { isLoaded: true, isSignedIn: false, userId: null as string | null },
  linkState: null as unknown,
  linkError: null as string | null,
  refreshLinkState: vi.fn(),
  scanError: null as string | null,
  scanPending: false,
}));

vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((runtime: never) => ({
      ...actual.createEnvironmentSessionAtoms(runtime),
      sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id),
    })) as never,
  };
});
vi.mock(import("../../cloud/publicConfig"), async (original) => ({
  ...(await original()),
  hasCloudPublicConfig: () => state.cloud,
}));
vi.mock(import("../../cloud/useRelayAccount"), async (original) => ({
  ...(await original()),
  useRelayAccount: (() => ({ ...state.auth, accountId: state.auth.userId })) as never,
}));
vi.mock(import("../relay-auth/relayAuthDialogState"), async (original) => ({
  ...(await original()),
  openRelaySignIn: () => {},
}));
vi.mock(import("../../cloud/cloudLinkState"), async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...(await original()),
    useCloudLinkState: (() => ({
      data: useAtomValue(state.linkState as Atom.Atom<EnvironmentCloudLinkStateResult | null>),
      error: state.linkError,
      isPending: false,
      refresh: state.refreshLinkState,
    })) as never,
  };
});
vi.mock(import("../../onboarding/firstRun"), async (original) => ({
  ...(await original()),
  completeOnboarding: state.completeOnboarding,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: state.computers, isReady: true })) as never,
  usePrimaryEnvironmentId: (() => state.primaryId) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: (() => state.providers) as never,
      configValueAtom: (() => state.config) as never,
      refreshProviders: "refreshProviders" as never,
      updateSettings: "updateSettings" as never,
    },
  };
});
vi.mock(import("../../state/entities"), async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...(await original()),
    useEnvironmentShellStatuses: (() =>
      new Map(state.computers.map(({ environmentId }) => [environmentId, "live"]))) as never,
    useProjects: (() => useAtomValue(state.projects as Atom.Atom<Project[]>)) as never,
    readProjects: (() => appAtomRegistry.get(state.projects as Atom.Atom<Project[]>)) as never,
    waitForProject: ((ref: unknown) => state.waitForProject(ref)) as never,
  };
});
vi.mock(import("../../state/projects"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    projectEnvironment: { create: "createProject" } as never,
    // Hosted setup leaves out computers whose workspace already has projects.
    environmentProjects: {
      ...actual.environmentProjects,
      projectsAtom: Atom.make((get) => get(state.projects as Atom.Atom<Project[]>)) as never,
    },
  };
});
vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      threadShellsAtom: Atom.make([]) as never,
    },
  };
});
vi.mock(import("../../state/agentSessions"), async (original) => ({
  ...(await original()),
  agentSessionImport: "importThreads" as never,
}));
vi.mock(import("../../onboarding/useProjectScans"), async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...(await original()),
    useProjectScans: (ids: readonly EnvironmentId[]) => {
      const candidates = useAtomValue(
        state.candidates as Atom.Atom<AgentSessionProjectCandidate[]>,
      );
      return ids.map((environmentId) => {
        state.scan({ environmentId });
        return {
          environmentId,
          data: (state.scanPending ? null : { candidates, truncated: false }) as never,
          isPending: state.scanPending,
          error: state.scanError,
          refresh: state.refreshScan,
        };
      });
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((
    command: "createProject" | "importThreads" | "refreshProviders" | "updateSettings",
  ) => state[command]) as never,
}));

// The T3 Code importer is tested on its own; here it reports the summary the test sets, keeps a
// preference choice the way the real importer does, and records calls.
vi.mock(import("../import/ImportComputer"), async () => {
  const { useEffect, useImperativeHandle, useState } = await import("react");
  const { useAtomValue } = await import("@effect/atom-react");
  function LegacyImportComputer({
    environmentId,
    onSummary,
    ref,
  }: {
    environmentId: EnvironmentId;
    onSummary: (id: EnvironmentId, summary: unknown) => void;
    ref: (importer: unknown) => void;
  }) {
    const summary = useAtomValue(state.t3Summary as Atom.Atom<T3Summary | null>);
    const [preferencesSelected, setPreferencesSelected] = useState<boolean | null>(null);
    useEffect(() => {
      if (summary === null) return;
      onSummary(
        environmentId,
        preferencesSelected === null ? summary : { ...summary, preferencesSelected },
      );
    }, [environmentId, onSummary, summary, preferencesSelected]);
    useImperativeHandle(ref, () => ({
      run: (options: unknown) => state.t3Run(environmentId, options),
      selectAllProjects: (selected: boolean) => state.t3SelectProjects(environmentId, selected),
      selectPreferences: (selected: boolean) => {
        state.t3SelectPreferences(environmentId, selected);
        setPreferencesSelected(selected);
      },
    }));
    return null;
  }
  return { LegacyImportComputer, HistoryImportComputer: () => null } as never;
});

import { welcomeImportSelectionKey } from "../../onboarding/welcomeState";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { toastManager } from "../ui/toast";
import { WelcomePage } from "./WelcomePage";

const primaryId = EnvironmentId.make("primary");
const readyClaude: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const permissionMessage = "This connection cannot import projects or thread history.";

function session(scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState {
  return {
    authenticated: true,
    scopes: [AuthOrchestrationReadScope, ...scopes],
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
  };
}

function sessionAtom(environmentId: EnvironmentId) {
  return state.sessions.get(environmentId) as Atom.Writable<SessionResult>;
}

function projectsAtom() {
  return state.projects as Atom.Writable<ReadonlyArray<Project>>;
}

function candidatesAtom() {
  return state.candidates as Atom.Writable<ReadonlyArray<AgentSessionProjectCandidate>>;
}

// Every listed computer gets a session that can import.
function addSessions() {
  for (const { environmentId } of state.computers) {
    state.sessions.set(
      environmentId,
      Atom.make<SessionResult>(AsyncResult.success(session([AuthOrchestrationOperateScope]))).pipe(
        Atom.keepAlive,
      ),
    );
  }
}

function checkboxNamed(screen: Awaited<ReturnType<typeof mountWelcome>>, name: RegExp) {
  return screen.getByRole("checkbox", { name }).element() as HTMLElement;
}

function computerCheckbox(screen: Awaited<ReturnType<typeof mountWelcome>>, name: string) {
  return checkboxNamed(screen, new RegExp(`^${name} `));
}

function setGrant(environmentId: EnvironmentId, allowed: boolean) {
  appAtomRegistry.set(
    sessionAtom(environmentId),
    AsyncResult.success(session(allowed ? [AuthOrchestrationOperateScope] : [])),
  );
}

// Default selection only picks recently active projects, so pin "now".
const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function candidate(
  path: string,
  overrides: Partial<AgentSessionProjectCandidate> = {},
): AgentSessionProjectCandidate {
  return {
    path,
    title: path.split("/").at(-1)!,
    sources: ["codex"],
    threadCount: 10,
    lastActiveAt: new Date(NOW - 60_000).toISOString(),
    alreadyImported: false,
    ...overrides,
  };
}

function recordProject({ environmentId, input }: CreateProjectInput) {
  appAtomRegistry.set(projectsAtom(), [
    ...appAtomRegistry.get(projectsAtom()),
    { id: input.projectId, environmentId, workspaceRoot: input.workspaceRoot },
  ]);
  return AsyncResult.success(undefined);
}

// Resolves once the project reaches the mocked projects atom; the real helper's timeout is
// replaced per test with a rejection.
function waitForRecordedProject(ref: { environmentId: EnvironmentId; projectId: string }) {
  const find = () =>
    appAtomRegistry
      .get(projectsAtom())
      .find(
        (project) => project.id === ref.projectId && project.environmentId === ref.environmentId,
      );
  return new Promise<Project>((resolve) => {
    const current = find();
    if (current) return resolve(current);
    const unsubscribe = appAtomRegistry.subscribe(projectsAtom(), () => {
      const project = find();
      if (!project) return;
      unsubscribe();
      resolve(project);
    });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function pageText() {
  return document.body.textContent ?? "";
}

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(label: string) {
  const target = button(label);
  expect(target.disabled).toBe(false);
  await act(async () => target.click());
}

async function mountWelcome({ automaticHostedFirstRun = false } = {}) {
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <WelcomePage
        environmentId={primaryId}
        automaticHostedFirstRun={automaticHostedFirstRun}
        onDone={state.onDone}
      />
    </RegistryContext.Provider>,
  );
}

const T3_FOUND: T3Summary = {
  projects: 1,
  threads: 1,
  preferences: 1,
  preferenceChanges: 2,
  previewPending: false,
  projectsAvailable: 1,
  preferencesSelected: true,
};

function setT3Summary(summary: T3Summary | null) {
  appAtomRegistry.set(state.t3Summary as Atom.Writable<T3Summary | null>, summary);
}

function computer(id: string, phase = "connected"): Computer {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    displayUrl: null,
    connection: { phase, error: null },
    entry: { enabled: true, target: { _tag: "DirectConnectionTarget" }, alternateRoutes: [] },
  };
}

// The mocked modules read `state`, so every test starts by replacing all of it.
// Returns the clock spy so each test can `using` it; the spy would otherwise outlive the test.
function setup() {
  const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
  state.computers = [computer("primary")];
  state.primaryId = "primary";
  state.sessions.clear();
  for (const id of [primaryId]) {
    state.sessions.set(
      id,
      Atom.make<SessionResult>(AsyncResult.success(session([AuthOrchestrationOperateScope]))).pipe(
        Atom.keepAlive,
      ),
    );
  }
  state.projects = Atom.make<ReadonlyArray<Project>>([]).pipe(Atom.keepAlive);
  state.providers = Atom.make<ReadonlyArray<ServerProvider>>([readyClaude]).pipe(Atom.keepAlive);
  state.config = Atom.make(null).pipe(Atom.keepAlive);
  state.candidates = Atom.make<ReadonlyArray<AgentSessionProjectCandidate>>([
    candidate("/projects/first"),
    candidate("/projects/second"),
  ]).pipe(Atom.keepAlive);
  state.createProject
    .mockReset()
    .mockImplementation(async (input: CreateProjectInput) => recordProject(input));
  state.importThreads
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ importedCount: 1, skippedCount: 0 }));
  state.refreshProviders.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateSettings.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.t3Summary = Atom.make<T3Summary | null>(null).pipe(Atom.keepAlive);
  state.t3Run.mockReset().mockResolvedValue({ success: true });
  state.t3SelectProjects.mockReset();
  state.t3SelectPreferences.mockReset();
  state.completeOnboarding.mockReset().mockResolvedValue(undefined);
  state.onDone.mockReset();
  state.scan.mockReset();
  state.refreshScan.mockReset();
  state.waitForProject.mockReset().mockImplementation(waitForRecordedProject);
  state.cloud = false;
  state.auth = { isLoaded: true, isSignedIn: false, userId: null };
  state.linkState = Atom.make<EnvironmentCloudLinkStateResult | null>(null).pipe(Atom.keepAlive);
  state.linkError = null;
  state.refreshLinkState.mockReset();
  state.scanError = null;
  state.scanPending = false;
  localStorage.removeItem(welcomeImportSelectionKey(primaryId));
  return now;
}

it("rechecks after project creation and can retry its history without recreating the project", async () => {
  using _now = setup();
  const creation = deferred<void>();
  state.createProject.mockImplementationOnce(async (input: CreateProjectInput) => {
    await creation.promise;
    return recordProject(input);
  });
  await using _screen = await mountWelcome();
  await click("Import 2 projects and start");
  expect(state.createProject).toHaveBeenCalledOnce();
  // Each project shows where its import is.
  expect(pageText()).toContain("firstImporting…");
  expect(pageText()).toContain("secondQueued");
  await act(async () => {
    setGrant(primaryId, false);
    creation.resolve();
    await creation.promise;
  });
  expect(state.importThreads).not.toHaveBeenCalled();
  expect(state.createProject).toHaveBeenCalledOnce();
  expect(state.onDone).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(pageText()).toContain(permissionMessage));

  await act(async () => setGrant(primaryId, true));
  // The first project now exists, so only the second counts as new.
  await click("Import 1 project and start");
  expect(state.createProject).toHaveBeenCalledTimes(2);
  expect(state.importThreads).toHaveBeenCalledTimes(2);
  expect(state.onDone).toHaveBeenCalledOnce();
});

it("completes accepted imports when permission is revoked after the final server write", async () => {
  using _now = setup();
  appAtomRegistry.set(candidatesAtom(), [candidate("/projects/first")]);
  const imported = deferred<{ importedCount: number; skippedCount: number }>();
  state.importThreads.mockImplementationOnce(async () =>
    AsyncResult.success(await imported.promise),
  );
  await using _screen = await mountWelcome();
  await click("Import 1 project and start");
  await act(async () => {
    setGrant(primaryId, false);
    imported.resolve({ importedCount: 1, skippedCount: 0 });
    await imported.promise;
  });
  expect(state.createProject).toHaveBeenCalledOnce();
  expect(state.importThreads).toHaveBeenCalledOnce();
  expect(state.completeOnboarding).toHaveBeenCalledOnce();
  expect(state.onDone).toHaveBeenCalledOnce();
});

it("finishes setup without landing when the imported project never reaches the client", async () => {
  using _now = setup();
  appAtomRegistry.set(candidatesAtom(), [candidate("/projects/first")]);
  // The server accepts the project, but it never shows up in the client's projects.
  state.createProject.mockResolvedValue(AsyncResult.success(undefined));
  state.waitForProject.mockRejectedValue(new Error("The project did not appear."));
  state.completeOnboarding.mockRejectedValueOnce(new Error("offline"));
  await using _screen = await mountWelcome();
  using toastAdd = vi.spyOn(toastManager, "add");

  await click("Import 1 project and start");
  await vi.waitFor(() => expect(state.completeOnboarding).toHaveBeenCalledOnce());
  // A failed completion hands the step back instead of leaving it importing.
  await vi.waitFor(() => expect(button("Import 1 project and start").disabled).toBe(false));
  expect(state.onDone).not.toHaveBeenCalled();

  await click("Import 1 project and start");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.onDone).toHaveBeenCalledWith(undefined);
  // The retry skips the project it already imported, but still counts its thread.
  await vi.waitFor(() =>
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Imported 1 thread" }),
    ),
  );
});

it("waits for a ready agent to start, and Start without an agent still finishes setup", async () => {
  using _now = setup();
  appAtomRegistry.set(state.providers as Atom.Writable<ReadonlyArray<ServerProvider>>, []);
  await using _screen = await mountWelcome();
  expect(button("Import 2 projects and start").disabled).toBe(true);

  await click("Start without an agent");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.createProject).toHaveBeenCalledTimes(2);
});

it("blocks leaving the page until the imported projects have landed", async () => {
  using _now = setup();
  const creation = deferred<void>();
  state.createProject.mockImplementationOnce(async (input: CreateProjectInput) => {
    await creation.promise;
    return recordProject(input);
  });
  const landing = deferred<void>();
  state.waitForProject.mockImplementation(
    async (ref: { environmentId: EnvironmentId; projectId: string }) => {
      await landing.promise;
      return waitForRecordedProject(ref);
    },
  );
  await using screen = await mountWelcome();
  await click("Import 2 projects and start");

  // A blocked navigation never settles, so it is not awaited.
  const leave = () =>
    act(async () => {
      void screen.router?.navigate({ to: "/settings" });
    });
  await leave();
  await act(async () => {
    creation.resolve();
    await creation.promise;
  });
  await vi.waitFor(() => expect(state.waitForProject).toHaveBeenCalledOnce());
  await leave();
  expect(screen.router?.state.location.pathname).toBe("/");

  const saved = deferred<void>();
  state.completeOnboarding.mockImplementationOnce(() => saved.promise);
  await act(async () => {
    landing.resolve();
    await landing.promise;
  });
  await vi.waitFor(() => expect(state.completeOnboarding).toHaveBeenCalledOnce());
  await leave();
  expect(screen.router?.state.location.pathname).toBe("/");

  await act(async () => {
    saved.resolve();
    await saved.promise;
  });
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(screen.router?.state.location.pathname).toBe("/");
  expect(state.createProject).toHaveBeenCalledTimes(2);
});

it("gives projects a later scan finds the default, unless the main box was unchecked", async () => {
  using _now = setup();
  await using _screen = await mountWelcome();
  // Turning on another agent rescans and finds a recent project the user has not seen.
  const findProject = (path: string) =>
    act(async () =>
      appAtomRegistry.set(candidatesAtom(), [
        ...appAtomRegistry.get(candidatesAtom()),
        candidate(path),
      ]),
    );

  await click("Review all 2");
  await click("Select none");
  await findProject("/projects/third");
  await vi.waitFor(() => expect(button("Import 1 project and start").disabled).toBe(false));

  const importProjects = document.querySelector<HTMLElement>('[role="checkbox"]');
  await act(async () => importProjects?.click());
  await findProject("/projects/fourth");
  await vi.waitFor(() => expect(button("Start").disabled).toBe(false));
});

it("keeps the project choice across a visit to Settings until setup finishes", async () => {
  using _now = setup();
  {
    await using _first = await mountWelcome();
    const importProjects = document.querySelector<HTMLElement>('[role="checkbox"]');
    await act(async () => importProjects?.click());
    await vi.waitFor(() => expect(button("Start").disabled).toBe(false));
  }
  // Coming back from Settings mounts the page again.
  {
    await using _second = await mountWelcome();
    expect(button("Start").disabled).toBe(false);
    await click("Start");
    await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
    expect(state.createProject).not.toHaveBeenCalled();
  }
  await using _third = await mountWelcome();
  expect(button("Import 2 projects and start").disabled).toBe(false);
});

it("stays busy while setup saves after an import that brought no threads", async () => {
  using _now = setup();
  appAtomRegistry.set(candidatesAtom(), [candidate("/projects/first")]);
  state.importThreads.mockResolvedValue(AsyncResult.success({ importedCount: 0, skippedCount: 0 }));
  const saved = deferred<void>();
  state.completeOnboarding.mockImplementationOnce(() => saved.promise);
  await using _screen = await mountWelcome();

  await click("Import 1 project and start");
  await vi.waitFor(() => expect(state.completeOnboarding).toHaveBeenCalledOnce());
  expect(button("Importing…").disabled).toBe(true);
  await act(async () => {
    saved.resolve();
    await saved.promise;
  });
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.createProject).toHaveBeenCalledOnce();
});

it("keeps projects whose history did not all import selected, so Start retries them", async () => {
  using _now = setup();
  state.importThreads
    .mockResolvedValueOnce(AsyncResult.success({ importedCount: 2, skippedCount: 0 }))
    .mockResolvedValueOnce(AsyncResult.success({ importedCount: 1, skippedCount: 1 }));
  await using _screen = await mountWelcome();

  await click("Import 2 projects and start");
  await vi.waitFor(() =>
    expect(pageText()).toContain(
      "Imported 3 threads. 1 thread could not be imported. Start again to retry what is still selected.",
    ),
  );
  expect(state.completeOnboarding).not.toHaveBeenCalled();
  expect(pageText()).toContain("secondCould not import all history");
  // Only the unfinished project stays checked; it exists now, so Start imports its threads again.
  expect(pageText()).toContain("Import 1 project and their threads");

  await click("Import threads and start");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.createProject).toHaveBeenCalledTimes(2);
  expect(state.importThreads).toHaveBeenCalledTimes(3);
  // Setup lands in the project the first run imported.
  const [first] = appAtomRegistry.get(projectsAtom());
  expect(state.onDone).toHaveBeenCalledWith({ environmentId: primaryId, projectId: first!.id });
});

it("leaves projects already in styal out of the default import, unless the box is checked", async () => {
  using _now = setup();
  const existing = ProjectId.make("existing");
  const justAdded = ProjectId.make("just-added");
  appAtomRegistry.set(projectsAtom(), [
    { id: existing, environmentId: primaryId, workspaceRoot: "/projects/first" },
    // Added a moment ago, so the cached scan does not know it exists yet.
    { id: justAdded, environmentId: primaryId, workspaceRoot: "/projects/second" },
  ]);
  appAtomRegistry.set(candidatesAtom(), [
    candidate("/projects/first", { alreadyImported: true, projectId: existing }),
    candidate("/projects/second"),
    candidate("/projects/third"),
  ]);
  {
    await using _screen = await mountWelcome();
    await vi.waitFor(() => expect(pageText()).toContain("Import 1 project and their threads"));
  }

  // With every project already in styal, checking the box still picks them.
  appAtomRegistry.set(candidatesAtom(), appAtomRegistry.get(candidatesAtom()).slice(0, 2));
  await using _screen = await mountWelcome();
  const importProjects = document.querySelector<HTMLElement>('[role="checkbox"]');
  await act(async () => importProjects?.click());
  await vi.waitFor(() => expect(pageText()).toContain("Import 2 projects and their threads"));
  expect(button("Import threads and start").disabled).toBe(false);
});

it("keeps the started projects checked when the page opens again after a quit", async () => {
  using _now = setup();
  const imported = deferred<{ importedCount: number; skippedCount: number }>();
  state.importThreads.mockImplementationOnce(async () =>
    AsyncResult.success(await imported.promise),
  );
  {
    await using _first = await mountWelcome();
    await click("Import 2 projects and start");
    await vi.waitFor(() => expect(state.importThreads).toHaveBeenCalledOnce());
  }
  // The app quit during the first project's history; it now exists in styal.
  const [first] = appAtomRegistry.get(projectsAtom());
  appAtomRegistry.set(candidatesAtom(), [
    candidate("/projects/first", { alreadyImported: true, projectId: first!.id }),
    candidate("/projects/second"),
  ]);
  await using _second = await mountWelcome();
  await vi.waitFor(() => expect(pageText()).toContain("Import 2 projects and their threads"));
});

it("keeps the project controls when a later scan fails", async () => {
  using _now = setup();
  await using _screen = await mountWelcome();
  state.scanError = "The scan timed out.";
  await act(async () =>
    appAtomRegistry.set(candidatesAtom(), [...appAtomRegistry.get(candidatesAtom())]),
  );
  await vi.waitFor(() => expect(pageText()).toContain("Could not check projects again."));
  expect(button("Import 2 projects and start").disabled).toBe(false);
  expect(button("Retry").disabled).toBe(false);
});

it("keeps saved picks when Start comes before the project list loads", async () => {
  using _now = setup();
  const saved = JSON.stringify({ knownKeys: ["a"], keys: ["a"], optedOut: false });
  localStorage.setItem(welcomeImportSelectionKey(primaryId), saved);
  state.scanPending = true;
  await using _screen = await mountWelcome();

  await click("Start");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  // An import a quit cut short is still checked on the next visit.
  expect(localStorage.getItem(welcomeImportSelectionKey(primaryId))).toBe(saved);
});

it("offers Update for a signed-in agent whose version is broken, and keeps Start off", async () => {
  using _now = setup();
  appAtomRegistry.set(state.providers as Atom.Writable<ReadonlyArray<ServerProvider>>, [
    {
      ...readyClaude,
      compatibilityAdvisory: {
        status: "broken",
        message: "Update Claude Code to 2.0 or later.",
        recommendedVersion: "2.0.0",
        recommendedRange: null,
      },
    },
  ]);
  await using _screen = await mountWelcome();
  await vi.waitFor(() => expect(pageText()).toContain("Update Claude Code to 2.0 or later."));
  const update = [...document.querySelectorAll("a")].find(
    (element) => element.textContent?.trim() === "Update",
  );
  expect(update?.getAttribute("href")).toContain("/settings/providers");
  expect(button("Import 2 projects and start").disabled).toBe(true);
});

it("keeps an import opt-out on the page when storage cannot save it", async () => {
  using _now = setup();
  await using _screen = await mountWelcome();
  using _full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  });
  const importProjects = document.querySelector<HTMLElement>('[role="checkbox"]');
  await act(async () => importProjects?.click());

  await click("Start");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.createProject).not.toHaveBeenCalled();
});

it("opens the list of agents to add once the checks find none, even after a wrong first status", async () => {
  using _now = setup();
  const pi = {
    ...readyClaude,
    instanceId: ProviderInstanceId.make("pi"),
    driver: ProviderDriverKind.make("pi"),
  };
  // Pi's first status says installed before its check runs.
  appAtomRegistry.set(state.providers as Atom.Writable<ReadonlyArray<ServerProvider>>, [
    { ...pi, status: "warning", auth: { status: "unknown" } },
  ]);
  await using _screen = await mountWelcome();
  await act(async () =>
    appAtomRegistry.set(state.providers as Atom.Writable<ReadonlyArray<ServerProvider>>, [
      { ...pi, installed: false, status: "error", auth: { status: "unknown" } },
    ]),
  );
  const fold = () =>
    [...document.querySelectorAll("button")].find((element) =>
      element.textContent?.startsWith("Set up an agent"),
    );
  await vi.waitFor(() => expect(fold()?.getAttribute("aria-expanded")).toBe("true"));

  // Turning an agent on starts a new check; the open list stays where the user is working.
  await act(async () =>
    appAtomRegistry.set(state.providers as Atom.Writable<ReadonlyArray<ServerProvider>>, [
      { ...pi, installed: false, status: "warning", auth: { status: "unknown" } },
    ]),
  );
  expect(fold()?.getAttribute("aria-expanded")).toBe("true");
});

it("starts without importing when this connection cannot import projects", async () => {
  using _now = setup();
  setGrant(primaryId, false);
  await using _screen = await mountWelcome();
  expect(pageText()).not.toContain("Review all");

  await click("Start");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.createProject).not.toHaveBeenCalled();
});

it("says the phone is set up only once this computer is shared with the signed-in account", async () => {
  using _now = setup();
  state.cloud = true;
  state.auth = { isLoaded: true, isSignedIn: true, userId: "user_1" };
  appAtomRegistry.set(
    sessionAtom(primaryId),
    AsyncResult.success(
      session([AuthOrchestrationOperateScope, AuthRelayReadScope, AuthRelayWriteScope]),
    ),
  );
  state.linkError = "Could not read T3 Connect link state.";
  await using _screen = await mountWelcome();
  await click("Set up");
  // A failed read says so instead of asking to share the computer again.
  await vi.waitFor(() => expect(pageText()).toContain("Could not check styal Link."));
  expect(pageText()).not.toContain("Set up styal Link");

  state.linkError = null;
  await act(async () =>
    appAtomRegistry.set(state.linkState as Atom.Writable<EnvironmentCloudLinkStateResult | null>, {
      linked: false,
      cloudUserId: null,
      relayUrl: null,
      relayIssuer: null,
      publishAgentActivity: false,
    }),
  );
  // Signed in, but "Not now" on the share step left this computer unreachable.
  await vi.waitFor(() => expect(pageText()).toContain("Set up styal Link"));

  const share = (reachability: EnvironmentCloudLinkStateResult["reachability"]) =>
    act(async () =>
      appAtomRegistry.set(
        state.linkState as Atom.Writable<EnvironmentCloudLinkStateResult | null>,
        {
          linked: true,
          cloudUserId: "user_1",
          relayUrl: null,
          relayIssuer: null,
          managedTunnelActive: true,
          publishAgentActivity: true,
          reachability,
        },
      ),
    );
  const checkedAt = "2026-01-01T00:00:00.000Z";
  await share({
    status: "unreachable",
    checkedAt,
    cause: "connector_not_running",
    reason: "The tunnel is not running.",
    hint: null,
    fix: "Turn T3 Connect off and on.",
  });
  await vi.waitFor(() => expect(pageText()).toContain("Check styal Link"));
  expect(pageText()).not.toContain("Your phone can reach this computer.");

  await share({ status: "reachable", checkedAt, readyConnections: 4, protocol: "quic" });
  await vi.waitFor(() => expect(pageText()).toContain("Your phone can reach this computer."));
  expect(pageText()).not.toContain("Check styal Link");
});

it("imports history to the computers this connection can write to", async () => {
  using _now = setup();
  state.computers = [computer("primary"), computer("laptop")];
  for (const { environmentId } of state.computers) {
    const scopes = environmentId === "laptop" ? [] : [AuthOrchestrationOperateScope];
    state.sessions.set(
      environmentId,
      Atom.make<SessionResult>(AsyncResult.success(session(scopes))).pipe(Atom.keepAlive),
    );
  }
  await using screen = await mountWelcome();
  const laptop = screen.getByRole("checkbox", { name: /^laptop / }).element() as HTMLElement;
  await act(async () => laptop.click());
  await vi.waitFor(() => expect(pageText()).toContain("Setting up 2 computers."));

  // laptop's projects are left out, and primary's can still be imported.
  await vi.waitFor(() => expect(pageText()).toContain("Import 2 projects and their threads"));
  expect(pageText()).toContain("cannot import projects or thread history on laptop.");
  // With several computers, each row names the one it imports to.
  await click("Review all 2");
  expect(pageText()).toContain("on primary");

  await click("Import 2 projects and start");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.createProject.mock.calls.map(([call]) => call.environmentId)).toEqual([
    primaryId,
    primaryId,
  ]);
});

it("sets up only the computers that are selected and connected", async () => {
  using _now = setup();
  state.computers = [
    computer("primary"),
    computer("laptop"),
    {
      ...computer("old-server", "unsupported"),
      connection: { phase: "unsupported", error: "Update it." },
    },
    computer("desktop", "offline"),
  ];
  addSessions();
  const scanned = () => new Set(state.scan.mock.calls.map(([call]) => call.environmentId));
  await using screen = await mountWelcome();
  const checkbox = (name: string) => computerCheckbox(screen, name);

  // Only the computer the page opened on is set up until another is chosen.
  expect(pageText()).toContain("Setting up primary.");
  expect(checkbox("primary").getAttribute("aria-checked")).toBe("true");
  expect(checkbox("laptop").getAttribute("aria-checked")).toBe("false");
  expect(scanned()).toEqual(new Set(["primary"]));
  // A computer that cannot talk to this app cannot be chosen.
  expect(checkbox("old-server").getAttribute("aria-disabled")).toBe("true");

  await act(async () => checkbox("laptop").click());
  await vi.waitFor(() => expect(pageText()).toContain("Setting up 2 computers."));
  expect(scanned()).toEqual(new Set(["primary", "laptop"]));

  // A selected computer that is not connected is left out, and the page says so.
  await act(async () => checkbox("desktop").click());
  await vi.waitFor(() => expect(pageText()).toContain("Not connected, so setup skips desktop."));
  expect(pageText()).toContain("Setting up 2 computers.");

  await act(async () => checkbox("primary").click());
  await vi.waitFor(() => expect(pageText()).toContain("Setting up laptop."));
});

it("saves the settling choice only where it differs, and stays when a save fails", async () => {
  using _now = setup();
  const settings = (onMerge: boolean, afterDays: number | null) => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    sidebarAutoSettleOnMerge: onMerge,
    sidebarAutoSettleAfterDays: afterDays,
  });
  state.computers = [
    { ...computer("primary"), serverConfig: { settings: settings(true, 7) } },
    { ...computer("laptop"), serverConfig: { settings: settings(false, 3) } },
    { ...computer("desktop"), serverConfig: { settings: settings(false, null) } },
  ];
  addSessions();
  appAtomRegistry.set(candidatesAtom(), []);
  await using screen = await mountWelcome();
  for (const name of ["laptop", "desktop"]) {
    await act(async () => computerCheckbox(screen, name).click());
  }
  await vi.waitFor(() => expect(pageText()).toContain("Setting up 3 computers."));
  // The choice starts from the first computer: both rules on, after its own 7 days.
  const merge = checkboxNamed(screen, /when its pull request merges/);
  const inactive = checkboxNamed(screen, /after 7 days without activity/);
  expect(merge.getAttribute("aria-checked")).toBe("true");
  expect(inactive.getAttribute("aria-checked")).toBe("true");
  await act(async () => merge.click());

  state.updateSettings.mockImplementation(async ({ environmentId }: { environmentId: string }) =>
    environmentId === "desktop"
      ? AsyncResult.failure(Cause.fail(new Error("offline")))
      : AsyncResult.success(undefined),
  );
  await click("Start");
  // laptop already settles only after inactivity, on its own 3 days, so it is left alone;
  // desktop turns inactivity settling on at the default.
  expect(state.updateSettings.mock.calls.map(([call]) => call)).toEqual([
    {
      environmentId: "primary",
      input: { patch: { sidebarAutoSettleOnMerge: false, sidebarAutoSettleAfterDays: 7 } },
    },
    {
      environmentId: "desktop",
      input: { patch: { sidebarAutoSettleOnMerge: false, sidebarAutoSettleAfterDays: 7 } },
    },
  ]);
  // The failed save keeps the page, so Start can try again.
  await vi.waitFor(() => expect(button("Start").disabled).toBe(false));
  expect(state.completeOnboarding).not.toHaveBeenCalled();

  state.updateSettings.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  await click("Start");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
});

it("offers T3 Code migration on its own, apart from the history import", async () => {
  using _now = setup();
  // Without a T3 Code install the page shows no T3 Code band.
  {
    await using first = await mountWelcome();
    expect(first.getByText("Import 2 projects and their threads").query()).not.toBeNull();
    // Hidden bands leave the accessibility tree, so no T3 Code heading is found.
    expect(first.getByRole("heading", { name: "T3 Code" }).query()).toBeNull();
  }
  setT3Summary({
    projects: 2,
    threads: 5,
    preferences: 1,
    preferenceChanges: 3,
    previewPending: false,
    projectsAvailable: 2,
    preferencesSelected: true,
  });
  const t3Project = { environmentId: primaryId, projectId: ProjectId.make("from-t3") };
  const order: string[] = [];
  state.t3Run.mockImplementation(async () => {
    order.push("t3");
    return { success: false };
  });
  state.createProject.mockImplementation(async (input: CreateProjectInput) => {
    order.push("history");
    return recordProject(input);
  });
  await using screen = await mountWelcome();
  await vi.waitFor(() => expect(pageText()).toContain("Import 2 projects from T3 Code"));
  expect(pageText()).toContain("Bring over T3 Code preferences");
  expect(pageText()).toContain("3 settings differ from styal");

  // Leaving out the history import leaves the T3 Code choices alone, and the two T3 Code rows
  // are separate choices.
  await act(async () => checkboxNamed(screen, /Import 2 projects and their threads/).click());
  await act(async () => checkboxNamed(screen, /Bring over T3 Code preferences/).click());
  expect(state.t3SelectPreferences).toHaveBeenCalledWith(primaryId, false);
  expect(state.t3SelectProjects).not.toHaveBeenCalled();

  // Start counts the T3 Code projects it imports.
  await click("Import 2 projects and start");
  // T3 Code imports projects and preferences together; a failure keeps the page for a retry.
  expect(state.t3Run).toHaveBeenCalledWith(primaryId, { includePreferences: true });
  await vi.waitFor(() => expect(pageText()).toContain("Some T3 Code data could not be imported"));
  expect(state.completeOnboarding).not.toHaveBeenCalled();
  expect(order).toEqual(["t3"]);

  state.t3Run.mockImplementation(async () => {
    order.push("t3");
    return { success: true, projectRef: t3Project };
  });
  await act(async () => checkboxNamed(screen, /Import projects and their threads/).click());
  await click("Import 4 projects and start");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  // T3 Code lands first, then the history import, which chooses where to land.
  expect(order).toEqual(["t3", "t3", "history", "history"]);
  expect(state.onDone.mock.calls[0]?.[0]).not.toEqual(t3Project);
});

it("waits for T3 Code discovery before starting, but not after a scan that finds nothing", async () => {
  using _now = setup();
  appAtomRegistry.set(candidatesAtom(), []);
  setT3Summary({
    ...T3_FOUND,
    projects: 0,
    projectsAvailable: 0,
    preferences: 0,
    preferenceChanges: 0,
    previewPending: true,
  });
  await using screen = await mountWelcome();
  expect(button("Start").disabled).toBe(true);
  expect(pageText()).toContain("Checking for T3 Code…");

  await act(async () => setT3Summary(T3_FOUND));
  await vi.waitFor(() => expect(pageText()).toContain("Import 1 project from T3 Code"));
  expect(button("Import 1 project and start").disabled).toBe(false);

  await act(async () =>
    setT3Summary({
      ...T3_FOUND,
      projects: 0,
      projectsAvailable: 0,
      preferences: 0,
      preferenceChanges: 0,
    }),
  );
  await vi.waitFor(() => expect(button("Start").disabled).toBe(false));
  expect(screen.getByRole("heading", { name: "T3 Code" }).query()).toBeNull();
  expect(pageText()).not.toContain("Checking for T3 Code…");
});

it("keeps a computer's T3 Code choices when it is unchecked and checked again", async () => {
  using _now = setup();
  state.computers = [computer("primary"), computer("laptop")];
  addSessions();
  appAtomRegistry.set(candidatesAtom(), []);
  setT3Summary(T3_FOUND);
  await using screen = await mountWelcome();
  const preferences = () => checkboxNamed(screen, /Bring over T3 Code preferences/);
  await act(async () => computerCheckbox(screen, "laptop").click());
  await vi.waitFor(() => expect(pageText()).toContain("Different on 2 computers"));
  await act(async () => preferences().click());
  await vi.waitFor(() => expect(preferences().getAttribute("aria-checked")).toBe("false"));

  await act(async () => computerCheckbox(screen, "laptop").click());
  await vi.waitFor(() => expect(pageText()).toContain("Setting up primary."));
  await act(async () => computerCheckbox(screen, "laptop").click());
  await vi.waitFor(() => expect(pageText()).toContain("Different on 2 computers"));
  expect(preferences().getAttribute("aria-checked")).toBe("false");
});

it("lands in the T3 Code project from the first try when the retry only brings preferences", async () => {
  using _now = setup();
  appAtomRegistry.set(candidatesAtom(), []);
  setT3Summary(T3_FOUND);
  const t3Project = { environmentId: primaryId, projectId: ProjectId.make("from-t3") };
  // The project request succeeds and the preference request fails; the retry sends preferences.
  state.t3Run
    .mockResolvedValueOnce({ success: false, projectRef: t3Project })
    .mockResolvedValueOnce({ success: true });
  state.waitForProject.mockResolvedValue({});
  await using _screen = await mountWelcome();
  await vi.waitFor(() => expect(pageText()).toContain("Import 1 project from T3 Code"));

  await click("Import 1 project and start");
  await vi.waitFor(() => expect(pageText()).toContain("Some T3 Code data could not be imported"));
  await click("Import 1 project and start");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledWith(t3Project));
});

it("keeps setting up an empty hosted computer once its T3 Code import adds projects", async () => {
  using _now = setup();
  appAtomRegistry.set(candidatesAtom(), []);
  setT3Summary(T3_FOUND);
  // The first imported project reaches the client before the import reports a failure.
  state.t3Run.mockImplementationOnce(async (environmentId: EnvironmentId) => {
    appAtomRegistry.set(projectsAtom(), [
      { id: ProjectId.make("from-t3"), environmentId, workspaceRoot: "/t3/first" },
    ]);
    return { success: false };
  });
  await using _screen = await mountWelcome({ automaticHostedFirstRun: true });
  await vi.waitFor(() => expect(pageText()).toContain("Import 1 project from T3 Code"));

  await click("Import 1 project and start");
  await vi.waitFor(() => expect(pageText()).toContain("Some T3 Code data could not be imported"));
  expect(pageText()).toContain("Setting up primary.");

  await click("Import 1 project and start");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.t3Run).toHaveBeenCalledTimes(2);
});

it("lands in the first T3 Code project when no history is imported", async () => {
  using _now = setup();
  appAtomRegistry.set(candidatesAtom(), []);
  setT3Summary({
    projects: 1,
    threads: 1,
    preferences: 0,
    preferenceChanges: 0,
    previewPending: false,
    projectsAvailable: 1,
    preferencesSelected: false,
  });
  const t3Project = { environmentId: primaryId, projectId: ProjectId.make("from-t3") };
  state.t3Run.mockResolvedValue({ success: true, projectRef: t3Project });
  state.waitForProject.mockResolvedValue({});
  await using _screen = await mountWelcome();
  await vi.waitFor(() => expect(pageText()).toContain("Import 1 project from T3 Code"));
  await click("Import 1 project and start");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledWith(t3Project));
});

it("points the phone at styal for Android releases and TestFlight, not app stores", async () => {
  using _now = setup();
  state.cloud = true;
  appAtomRegistry.set(
    sessionAtom(primaryId),
    AsyncResult.success(
      session([AuthOrchestrationOperateScope, AuthRelayReadScope, AuthRelayWriteScope]),
    ),
  );
  await using _screen = await mountWelcome();
  await click("Set up");
  const releases = [...document.querySelectorAll("a")].find(
    (link) => link.textContent?.trim() === "Open Android releases",
  );
  expect(releases?.getAttribute("href")).toBe(
    "https://github.com/incognitojam/styal/releases?q=%22styal+for+Android%22",
  );
  expect(document.querySelector("svg title")?.textContent).toBe("styal for Android releases");
  expect(pageText()).toContain("TestFlight, which is invite-only");
  expect(pageText()).toContain("Sign in to styal Link");
  expect(pageText()).not.toMatch(/App Store|Google Play/);
});
