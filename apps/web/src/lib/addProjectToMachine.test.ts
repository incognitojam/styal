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
