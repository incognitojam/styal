import { EnvironmentId, type ProjectCloneSnapshot, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { addProjectToMachine } from "./addProjectToMachine";

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

const target = EnvironmentId.make("build-server");
const projectId = ProjectId.make("project-1");

describe("addProjectToMachine", () => {
  it("resolves once the target lists the clone, not when the start request returns", async () => {
    appAtomRegistry.set(clonesAtom, []);
    mocks.runAtomCommand.mockResolvedValue({
      _tag: "Success",
      value: { projectId, cwd: "~/Hello-World", remoteUrl: "git@example.com:o/r.git" },
    });

    let listedWhenResolved: number | null = null;
    const added = addProjectToMachine({
      source: { environmentId: EnvironmentId.make("studio-mac"), cwd: "/Users/dev/hello-world" },
      subdirectory: "",
      target: { environmentId: target, label: "build-server" },
      projectId,
      title: "hello-world",
      remoteUrl: "git@example.com:o/r.git",
      destinationPath: "~/Hello-World",
      files: [],
    }).then((id) => {
      listedWhenResolved = appAtomRegistry.get(clonesAtom).length;
      return id;
    });

    await vi.waitFor(() => expect(mocks.runAtomCommand).toHaveBeenCalled());
    appAtomRegistry.set(clonesAtom, [
      {
        projectId,
        remoteUrl: "git@example.com:o/r.git",
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
    expect(listedWhenResolved).toBe(1);
  });
});
