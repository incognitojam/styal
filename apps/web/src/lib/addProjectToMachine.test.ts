import { EnvironmentId, type ProjectCloneSnapshot, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { addProjectToMachine, settleCancelledAdd } from "./addProjectToMachine";

const mocks = vi.hoisted(() => ({
  runAtomCommand: vi.fn(),
  executeAtomQuery: vi.fn(),
}));

const clonesAtom = Atom.make<ReadonlyArray<ProjectCloneSnapshot>>([]).pipe(Atom.keepAlive);

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: mocks.executeAtomQuery,
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: vi.fn(),
}));
vi.mock("../state/projectClones", () => ({
  environmentProjectClonesAtom: () => clonesAtom,
  silenceProjectCloneToasts: vi.fn(),
}));
vi.mock("../components/sourceControlAppAccessToast", () => ({
  suggestAppAccessForRemote: vi.fn(),
}));
vi.mock("../state/projects", () => ({ projectEnvironment: {} }));
vi.mock("../state/filesystem", () => ({ filesystemEnvironment: { getMetadata: vi.fn() } }));
vi.mock("../state/sourceControl", () => ({ sourceControlEnvironment: {} }));

const projectId = ProjectId.make("project-1");
const remoteUrl = "git@example.com:o/r.git";

function startAdd() {
  appAtomRegistry.set(clonesAtom, []);
  mocks.runAtomCommand.mockResolvedValue({
    _tag: "Success",
    value: { projectId, cwd: "~/Hello-World", remoteUrl },
  });
  let settled = false;
  const added = addProjectToMachine({
    source: { environmentId: EnvironmentId.make("studio-mac"), cwd: "/Users/dev/hello-world" },
    subdirectory: "",
    target: { environmentId: EnvironmentId.make("build-server"), label: "build-server" },
    projectId,
    title: "hello-world",
    remoteUrl,
    destinationPath: "~/Hello-World",
    files: [],
  }).finally(() => {
    settled = true;
  });
  return { added, settled: () => settled };
}

describe("addProjectToMachine", () => {
  it("resolves once the target lists the clone, not when the start request returns", async () => {
    vi.useFakeTimers();
    try {
      const { added, settled } = startAdd();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled()).toBe(false);

      appAtomRegistry.set(clonesAtom, [
        {
          projectId,
          remoteUrl,
          destinationPath: "~/Hello-World",
          repository: null,
          phase: "running",
          stage: "connecting",
          percent: null,
          detail: null,
          error: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: null,
          sequence: 1,
        },
      ]);
      await expect(added).resolves.toBe(projectId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting for the listing after ten seconds", async () => {
    vi.useFakeTimers();
    try {
      const { added, settled } = startAdd();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(added).resolves.toBe(projectId);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("settleCancelledAdd", () => {
  const target = { environmentId: EnvironmentId.make("build-server"), projectId };
  const clone = (phase: ProjectCloneSnapshot["phase"]): ProjectCloneSnapshot => ({
    projectId,
    remoteUrl,
    destinationPath: "~/Hello-World",
    repository: null,
    phase,
    stage: "receiving",
    percent: null,
    detail: null,
    error: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    sequence: 1,
  });
  // Answers each command by its label; the cancel moves the clone to `phaseAfterCancel`, and the
  // folder check finds the destination gone unless `folderLeft`.
  const commands = (phaseAfterCancel: ProjectCloneSnapshot["phase"], folderLeft = false) => {
    mocks.executeAtomQuery.mockReset();
    mocks.executeAtomQuery.mockResolvedValue({
      _tag: "Success",
      value: { entries: [folderLeft ? { kind: "directory" } : null] },
    });
    mocks.runAtomCommand.mockReset();
    mocks.runAtomCommand.mockImplementation(
      async (_registry: unknown, _command: unknown, _args: unknown, options: { label: string }) => {
        if (options.label === "Cancel clone") {
          appAtomRegistry.set(clonesAtom, [clone(phaseAfterCancel)]);
          return { _tag: "Success", value: { applied: true } };
        }
        return { _tag: "Success", value: {} };
      },
    );
  };
  const labels = () =>
    mocks.runAtomCommand.mock.calls.map((call) => (call[3] as { label: string }).label);

  it("stops a running clone this add started, then removes the project it created", async () => {
    appAtomRegistry.set(clonesAtom, [clone("running")]);
    commands("cancelled");

    await expect(settleCancelledAdd(target, true)).resolves.toBe("removed");
    expect(labels()).toEqual(["Cancel clone", "Remove cancelled clone"]);
  });

  it("reports a cancelled clone whose folder the machine could not delete", async () => {
    appAtomRegistry.set(clonesAtom, [clone("running")]);
    commands("cancelled", true);

    await expect(settleCancelledAdd(target, true)).resolves.toBe("failed");
    expect(labels()).toEqual(["Cancel clone", "Remove cancelled clone"]);
  });

  it("keeps a clone that finished before the cancel arrived", async () => {
    appAtomRegistry.set(clonesAtom, [clone("done")]);
    commands("done");

    await expect(settleCancelledAdd(target, true)).resolves.toBe("completed");
    expect(labels()).toEqual([]);
  });

  it("keeps a clone that finished while it was being cancelled", async () => {
    appAtomRegistry.set(clonesAtom, [clone("running")]);
    commands("done");

    await expect(settleCancelledAdd(target, true)).resolves.toBe("completed");
    expect(labels()).toEqual(["Cancel clone"]);
  });

  it("leaves a project the machine already had alone, clone included", async () => {
    appAtomRegistry.set(clonesAtom, [clone("running")]);
    commands("cancelled");

    await expect(settleCancelledAdd(target, false)).resolves.toBe("existing");
    expect(labels()).toEqual([]);
  });
});
