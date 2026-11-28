import { EnvironmentId, type ProjectCloneSnapshot, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { addProjectToMachine, settleCancelledAdd } from "./addProjectToMachine";

const mocks = vi.hoisted(() => ({
  runAtomCommand: vi.fn(),
}));

const clonesAtom = Atom.make<ReadonlyArray<ProjectCloneSnapshot>>([]).pipe(Atom.keepAlive);

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: vi.fn(),
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
vi.mock("../state/sourceControl", () => ({ sourceControlEnvironment: {} }));

const projectId = ProjectId.make("project-1");
const remoteUrl = "git@example.com:o/r.git";

function startAdd(
  startReply: Promise<unknown> = Promise.resolve({
    _tag: "Success",
    value: { projectId, cwd: "~/Hello-World", remoteUrl },
  }),
) {
  appAtomRegistry.set(clonesAtom, []);
  mocks.runAtomCommand.mockReturnValue(startReply);
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

  it("gives up on a start request the target does not answer within 30 seconds", async () => {
    vi.useFakeTimers();
    try {
      const { added, settled } = startAdd(new Promise(() => undefined));
      const rejected = expect(added).rejects.toThrow("build-server did not answer.");
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
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
  // Answers each command by its label; the cancel moves the clone to `phaseAfterCancel`.
  const commands = (phaseAfterCancel: ProjectCloneSnapshot["phase"]) => {
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

  it("counts a cancel the machine does not answer within 30 seconds as failed", async () => {
    vi.useFakeTimers();
    try {
      appAtomRegistry.set(clonesAtom, [clone("running")]);
      mocks.runAtomCommand.mockReset();
      mocks.runAtomCommand.mockReturnValue(new Promise(() => undefined));

      const settled = settleCancelledAdd(target, true);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(settled).resolves.toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });
});
