import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { DraftId } from "../composerDraftStore";
import { NoAnswerError, readPreparingAdd, usePreparingAdd } from "../lib/addProjectToMachine";
import { act, render } from "../../test/render";

const project = vi.hoisted(() => {
  let value: unknown = null;
  const listeners = new Set<() => void>();
  return {
    // Each test starts from no project and no listeners left by an earlier test, and a request
    // an earlier test left open ends with its project.
    setup: (initial: unknown) => {
      value = null;
      for (const listener of listeners) listener();
      listeners.clear();
      value = initial;
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
  settleCancelledAdd: scene.discard as never,
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

// Base UI's inert backdrop takes pointer events in the test frame, so dialog buttons are
// clicked through the DOM.
const clickButton = (name: string) =>
  act(() => (page.getByRole("button", { name }).element() as HTMLElement).click());

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

  it("ignores any other add while a one-click add is being decided", async () => {
    scene.setup();
    project.setup(PROJECT);
    targets.setup([machine("machine-a"), machine("machine-b")]);
    await using screen = await render(<AddProjectToMachineDialogHost />);

    await act(() => {
      openAddProjectToMachine({
        projectRef,
        targetEnvironmentId: EnvironmentId.make("machine-a"),
        quick: true,
        draftId: DraftId.make("draft-1"),
      });
      openAddProjectToMachine({
        projectRef,
        targetEnvironmentId: EnvironmentId.make("machine-b"),
        quick: true,
        draftId: DraftId.make("draft-2"),
      });
      openAddProjectToMachine({ projectRef, targetEnvironmentId: null });
    });

    // The source cannot list ignored files here, so the add asks: about the first machine.
    await expect
      .element(screen.getByRole("combobox", { name: "Machine to add the project to" }))
      .toHaveTextContent("machine-a");
    expect(readPreparingAdd()?.draftId).toBe("draft-1");
  });

  it("shows the add's row only while its draft is still on the project being added", async () => {
    scene.setup();
    project.setup(PROJECT);
    targets.setup([machine("machine-a")]);
    const Row = ({ shownFor }: { shownFor: typeof projectRef }) => (
      <p>{usePreparingAdd(DraftId.make("draft-9"), shownFor) ? "Row shown" : "No row"}</p>
    );
    await using screen = await render(
      <>
        <AddProjectToMachineDialogHost />
        <Row shownFor={projectRef} />
      </>,
    );

    await act(() =>
      openAddProjectToMachine({
        projectRef,
        targetEnvironmentId: EnvironmentId.make("machine-a"),
        quick: true,
        draftId: DraftId.make("draft-9"),
      }),
    );
    await expect.element(screen.getByText("Row shown")).toBeInTheDocument();

    // The draft was switched to another project while the add prepares.
    await screen.rerender(
      <>
        <AddProjectToMachineDialogHost />
        <Row shownFor={scopeProjectRef(environmentId, ProjectId.make("project-2"))} />
      </>,
    );
    await expect.element(screen.getByText("No row")).toBeInTheDocument();
  });

  it("frees the Add rows when a one-click add's project vanishes before the add shows", async () => {
    scene.setup();
    project.setup(PROJECT);
    targets.setup([machine("machine-a")]);
    await using screen = await render(<AddProjectToMachineDialogHost />);
    const quickAdd = () =>
      openAddProjectToMachine({
        projectRef,
        targetEnvironmentId: EnvironmentId.make("machine-a"),
        quick: true,
        draftId: DraftId.make("draft-3"),
      });

    await act(() => {
      quickAdd();
      project.set(null);
    });
    expect(readPreparingAdd()).toBeNull();

    await act(() => project.set(PROJECT));
    await act(quickAdd);
    await expect.element(screen.getByText("Clone to machine-a")).toBeInTheDocument();
  });

  it("frees the Add rows and shows why when the clone cannot start", async () => {
    scene.setup({ environments: [SOURCE], query: scene.answered });
    scene.add.mockRejectedValue(new Error("machine-a did not answer."));
    project.setup(PROJECT);
    targets.setup([machine("machine-a")]);
    await using screen = await render(<AddProjectToMachineDialogHost />);

    await act(() =>
      openAddProjectToMachine({
        projectRef,
        targetEnvironmentId: EnvironmentId.make("machine-a"),
        quick: true,
        draftId: DraftId.make("draft-4"),
      }),
    );

    await expect.element(screen.getByText("machine-a did not answer.")).toBeInTheDocument();
    expect(readPreparingAdd()).toBeNull();
  });

  it("keeps the Add rows waiting until an add cancelled while its request is out settles", async () => {
    scene.setup({ environments: [SOURCE], query: scene.answered });
    let settle: (outcome: string) => void = () => undefined;
    scene.discard.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
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

    await act(() =>
      openAddProjectToMachine({
        projectRef,
        targetEnvironmentId: EnvironmentId.make("machine-a"),
        quick: true,
        draftId: DraftId.make("draft-5"),
      }),
    );
    await vi.waitFor(() => expect(readPreparingAdd()?.sending).toBe(true));
    await act(() => readPreparingAdd()?.onCancel());
    expect(readPreparingAdd()?.cancelled).toBe(true);

    // The server answered with a project it already had, so it is not this add's to remove.
    await act(() => finishAdd(ProjectId.make("existing-1")));
    await vi.waitFor(() =>
      expect(scene.discard).toHaveBeenCalledWith(
        scopeProjectRef(EnvironmentId.make("machine-a"), ProjectId.make("existing-1")),
        false,
      ),
    );
    expect(readPreparingAdd()?.cancelled).toBe(true);
    await act(() => settle("existing"));
    expect(readPreparingAdd()).toBeNull();
    await expect.element(screen.getByText("Add to another machine")).not.toBeInTheDocument();
  });

  it.each([
    ["its Cancel button", () => clickButton("Cancel")],
    ["Escape", () => userEvent.keyboard("{Escape}")],
  ])(
    "cancels the clone when the dialog is closed with %s while its request is out",
    async (_, dismiss) => {
      scene.setup({ environments: [SOURCE], query: scene.answered });
      scene.discard.mockResolvedValue("removed");
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

      await act(() =>
        openAddProjectToMachine({
          projectRef,
          targetEnvironmentId: EnvironmentId.make("machine-a"),
        }),
      );
      await clickButton("Clone to machine-a");
      await vi.waitFor(() => expect(scene.add).toHaveBeenCalledOnce());
      await dismiss();
      await expect.element(screen.getByText("Add to another machine")).not.toBeInTheDocument();

      // The server created the project this add asked for, so it is this add's to remove.
      const requested = (scene.add.mock.calls[0] as [{ projectId: ProjectId }])[0].projectId;
      await act(() => finishAdd(requested));
      await vi.waitFor(() =>
        expect(scene.discard).toHaveBeenCalledWith(
          scopeProjectRef(EnvironmentId.make("machine-a"), requested),
          true,
        ),
      );
    },
  );

  it("keeps a remounted dialog on its clone request: one start, and its error shows", async () => {
    scene.setup({ environments: [SOURCE], query: scene.answered });
    let failStart: (cause: unknown) => void = () => undefined;
    scene.add.mockImplementation(
      () =>
        new Promise<ProjectId>((_resolve, reject) => {
          failStart = reject;
        }),
    );
    project.setup(PROJECT);
    targets.setup([machine("machine-a")]);
    await using screen = await render(<AddProjectToMachineDialogHost />);

    await act(() =>
      openAddProjectToMachine({ projectRef, targetEnvironmentId: EnvironmentId.make("machine-a") }),
    );
    await clickButton("Clone to machine-a");
    // As when the root route swaps the tree that renders the host.
    await screen.rerender(<></>);
    await screen.rerender(<AddProjectToMachineDialogHost />);

    await expect.element(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    expect(scene.add).toHaveBeenCalledOnce();
    await act(() => failStart(new Error("machine-a refused the clone.")));
    await expect.element(screen.getByText("machine-a refused the clone.")).toBeInTheDocument();
  });

  it("cancels the clone from a dialog that remounted while its request is out", async () => {
    scene.setup({ environments: [SOURCE], query: scene.answered });
    scene.discard.mockResolvedValue("removed");
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

    await act(() =>
      openAddProjectToMachine({ projectRef, targetEnvironmentId: EnvironmentId.make("machine-a") }),
    );
    await clickButton("Clone to machine-a");
    await screen.rerender(<></>);
    await screen.rerender(<AddProjectToMachineDialogHost />);
    await clickButton("Cancel");

    const requested = (scene.add.mock.calls[0] as [{ projectId: ProjectId }])[0].projectId;
    await act(() => finishAdd(requested));
    await vi.waitFor(() =>
      expect(scene.discard).toHaveBeenCalledWith(
        scopeProjectRef(EnvironmentId.make("machine-a"), requested),
        true,
      ),
    );
  });

  it("says a cancelled add may still be there when its start went unanswered", async () => {
    scene.setup({ environments: [SOURCE], query: scene.answered });
    let failStart: (cause: unknown) => void = () => undefined;
    scene.add.mockImplementation(
      () =>
        new Promise<ProjectId>((_resolve, reject) => {
          failStart = reject;
        }),
    );
    project.setup(PROJECT);
    targets.setup([machine("machine-a")]);
    await using _screen = await render(<AddProjectToMachineDialogHost />);

    await act(() =>
      openAddProjectToMachine({
        projectRef,
        targetEnvironmentId: EnvironmentId.make("machine-a"),
        quick: true,
        draftId: DraftId.make("draft-11"),
      }),
    );
    await vi.waitFor(() => expect(readPreparingAdd()?.sending).toBe(true));
    await act(() => readPreparingAdd()?.onCancel());
    await act(() => failStart(new NoAnswerError({ message: "machine-a did not answer." })));

    expect(readPreparingAdd()).toBeNull();
    expect(scene.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Could not finish cancelling on machine-a",
      }),
    );
  });
});
