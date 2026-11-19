import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftId } from "../composerDraftStore";
import { readPreparingAdd, setPreparingAdd } from "../lib/addProjectToMachine";
import { act, render } from "../../test/render";

const project = vi.hoisted(() => {
  let value: unknown = null;
  const listeners = new Set<() => void>();
  return {
    // Each test starts from no project and no listeners left by an earlier test.
    setup: (initial: unknown) => {
      value = initial;
      listeners.clear();
    },
    get: () => value,
    set: (next: unknown) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock(import("../state/entities"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    readProject: (() => project.get()) as never,
    subscribeProject: ((_ref: unknown, listener: (value: unknown) => void) =>
      project.subscribe(() => listener(project.get()))) as never,
    useProject: (() => useSyncExternalStore(project.subscribe, project.get)) as never,
  };
});
const scene = vi.hoisted(() => {
  const refresh = () => undefined;
  const pending = {
    data: null,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: true,
    isSuccess: false,
    refresh,
  };
  let environments: unknown[] = [];
  let query: unknown = pending;
  const add = vi.fn();
  const discard = vi.fn();
  const toast = vi.fn();
  return {
    // Answers both of the dialog's checks: no ignored files, and no folder at the destination.
    answered: {
      data: { files: [], truncated: false, entries: [null] },
      dataUpdatedAt: Number.MAX_SAFE_INTEGER,
      error: null,
      failure: null,
      isPending: false,
      isSuccess: true,
      refresh,
    },
    setup: (next: { environments?: unknown[]; query?: unknown } = {}) => {
      environments = next.environments ?? [];
      query = next.query ?? pending;
      add.mockReset();
      discard.mockReset();
      toast.mockReset();
    },
    environments: () => environments,
    query: () => query,
    add,
    discard,
    toast,
  };
});

vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: scene.environments() })) as never,
}));
vi.mock(import("../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => scene.query()) as never,
}));
vi.mock(import("../lib/addProjectToMachine"), async (original) => ({
  ...(await original()),
  addProjectToMachine: scene.add as never,
  discardStartedClone: scene.discard as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: scene.toast as never } };
});
vi.mock(import("../hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => () => undefined) as never,
}));
const targets = vi.hoisted(() => {
  let value: unknown[] = [];
  return {
    setup: (initial: unknown[]) => {
      value = initial;
    },
    get: () => value,
  };
});

vi.mock(import("../hooks/useAddProjectTargets"), async (original) => ({
  ...(await original()),
  useAddProjectTargets: (() => targets.get()) as never,
}));
vi.mock(import("../hooks/useLogicalProjectEnvironments"), async (original) => ({
  ...(await original()),
  useLogicalProjectEnvironments: (() => []) as never,
}));

import {
  AddProjectToMachineDialogHost,
  openAddProjectToMachine,
} from "./AddProjectToMachineDialog";

const environmentId = EnvironmentId.make("environment-1");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
const PROJECT = {
  environmentId,
  id: projectRef.projectId,
  title: "Repo",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
};

const SOURCE = {
  environmentId,
  label: "studio-mac",
  serverConfig: {
    environment: {
      capabilities: { ignoredFileListing: true },
      platform: { os: "darwin", arch: "arm64" },
    },
  },
};

const machine = (name: string) => ({
  environmentId: EnvironmentId.make(name),
  label: name,
  machine: "server",
  destinationPath: "~/Repo",
});

describe("AddProjectToMachineDialog", () => {
  it("closes when its project goes away", async () => {
    scene.setup();
    project.setup(PROJECT);
    targets.setup([]);
    await using screen = await render(<AddProjectToMachineDialogHost />);

    await act(() => openAddProjectToMachine({ projectRef, targetEnvironmentId: null }));
    await expect.element(screen.getByText("Add to another machine")).toBeInTheDocument();

    await act(() => project.set(null));
    await act(() => project.set(PROJECT));
    await expect.element(screen.getByText("Add to another machine")).not.toBeInTheDocument();
  });

  it("does not reopen for a project that vanished before the dialog showed", async () => {
    scene.setup();
    project.setup(PROJECT);
    targets.setup([]);
    await using screen = await render(<AddProjectToMachineDialogHost />);

    await act(() => {
      openAddProjectToMachine({ projectRef, targetEnvironmentId: null });
      project.set(null);
    });
    await act(() => project.set(PROJECT));

    await expect.element(screen.getByText("Add to another machine")).not.toBeInTheDocument();
  });

  it("ignores a second machine picked while the first one-click add is preparing", async () => {
    scene.setup();
    project.setup(PROJECT);
    targets.setup([machine("machine-a"), machine("machine-b")]);
    await using screen = await render(<AddProjectToMachineDialogHost />);
    const draftId = DraftId.make("draft-1");

    await act(() => {
      openAddProjectToMachine({
        projectRef,
        targetEnvironmentId: EnvironmentId.make("machine-a"),
        quick: true,
        draftId,
      });
      openAddProjectToMachine({
        projectRef,
        targetEnvironmentId: EnvironmentId.make("machine-b"),
        quick: true,
        draftId,
      });
    });

    // The source cannot list ignored files here, so the add asks: about the first machine.
    await expect
      .element(screen.getByRole("combobox", { name: "Machine to add the project to" }))
      .toHaveTextContent("machine-a");
  });

  it("frees the draft when a one-click add's project vanishes before the add shows", async () => {
    scene.setup();
    project.setup(PROJECT);
    targets.setup([machine("machine-a")]);
    await using screen = await render(<AddProjectToMachineDialogHost />);
    const draftId = DraftId.make("draft-2");
    const quickAdd = () =>
      openAddProjectToMachine({
        projectRef,
        targetEnvironmentId: EnvironmentId.make("machine-a"),
        quick: true,
        draftId,
      });

    await act(() => {
      quickAdd();
      project.set(null);
    });
    expect(readPreparingAdd(draftId)).toBeNull();

    await act(() => project.set(PROJECT));
    await act(quickAdd);
    await expect.element(screen.getByText("Clone to machine-a")).toBeInTheDocument();
  });

  it("keeps a draft's row while its clone is being sent, even when another add replaces it", async () => {
    scene.setup();
    project.setup(PROJECT);
    targets.setup([machine("machine-a")]);
    await using screen = await render(<AddProjectToMachineDialogHost />);
    const sendingDraft = DraftId.make("draft-3");

    await act(() =>
      openAddProjectToMachine({
        projectRef,
        targetEnvironmentId: EnvironmentId.make("machine-a"),
        quick: true,
        draftId: sendingDraft,
      }),
    );
    await expect.element(screen.getByText("Clone to machine-a")).toBeInTheDocument();
    // As if its clone request were out.
    setPreparingAdd(sendingDraft, { title: "Adding to machine-a", sending: true });

    await act(() =>
      openAddProjectToMachine({
        projectRef,
        targetEnvironmentId: null,
        draftId: DraftId.make("draft-4"),
      }),
    );
    expect(readPreparingAdd(sendingDraft)).toEqual({ title: "Adding to machine-a", sending: true });
  });

  it("refuses an add from another draft while one is preparing, and says why", async () => {
    scene.setup({ environments: [SOURCE] });
    project.setup(PROJECT);
    targets.setup([machine("machine-a")]);
    await using screen = await render(<AddProjectToMachineDialogHost />);
    const preparing = DraftId.make("draft-5");

    await act(() =>
      openAddProjectToMachine({
        projectRef,
        targetEnvironmentId: EnvironmentId.make("machine-a"),
        quick: true,
        draftId: preparing,
      }),
    );
    await act(() =>
      openAddProjectToMachine({
        projectRef,
        targetEnvironmentId: null,
        draftId: DraftId.make("draft-6"),
      }),
    );

    expect(readPreparingAdd(preparing)).not.toBeNull();
    expect(scene.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Another add is still preparing" }),
    );
    await expect.element(screen.getByText("Add to another machine")).not.toBeInTheDocument();
    await act(() => readPreparingAdd(preparing)?.onCancel?.());
  });

  it("lets go of an add cancelled while its clone request is out, and removes that clone", async () => {
    scene.setup({ environments: [SOURCE], query: scene.answered });
    let finishAdd: (projectId: ProjectId) => void = () => undefined;
    scene.add.mockImplementation(
      () =>
        new Promise<ProjectId>((resolve) => {
          finishAdd = resolve;
        }),
    );
    project.setup(PROJECT);
    targets.setup([machine("machine-a")]);
    await using screen = await render(<AddProjectToMachineDialogHost />);
    const draftId = DraftId.make("draft-7");

    await act(() =>
      openAddProjectToMachine({
        projectRef,
        targetEnvironmentId: EnvironmentId.make("machine-a"),
        quick: true,
        draftId,
      }),
    );
    await vi.waitFor(() => expect(readPreparingAdd(draftId)?.sending).toBe(true));
    await act(() => readPreparingAdd(draftId)?.onCancel?.());
    expect(readPreparingAdd(draftId)).toBeNull();

    await act(() => finishAdd(ProjectId.make("cloned-1")));
    await vi.waitFor(() =>
      expect(scene.discard).toHaveBeenCalledWith(
        scopeProjectRef(EnvironmentId.make("machine-a"), ProjectId.make("cloned-1")),
      ),
    );
    await expect.element(screen.getByText("Add to another machine")).not.toBeInTheDocument();
  });
});
