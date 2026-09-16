import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  importThreads: vi.fn(),
  refresh: vi.fn(),
  candidates: [] as Array<{
    title: string;
    path: string;
    projectId?: ProjectId;
    threadCount: number;
    sources: ("codex" | "claudeAgent")[];
    lastActiveAt: string;
  }>,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useMemo: reactHookHarness.useMemo,
    useEffect: vi.fn(),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../onboarding/useProjectScans", () => ({
  useProjectScans: (ids: EnvironmentId[]) => [
    {
      environmentId: ids[0],
      data: { candidates: mocks.candidates },
      error: null,
      isPending: false,
      refresh: mocks.refresh,
    },
  ],
}));
vi.mock("../../state/entities", () => ({ readProjects: () => [] }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../../state/agentSessions", () => ({ agentSessionImport: "history" }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "create" ? mocks.create : mocks.importThreads),
}));
import { useHistoryImport } from "./useHistoryImport";
const environmentId = EnvironmentId.make("demo-desktop");
const render = () => {
  hooks.beginRender();
  return useHistoryImport(environmentId);
};
describe("shared CLI history importer", () => {
  beforeEach(() => {
    hooks.reset();
    mocks.create.mockReset();
    mocks.importThreads.mockReset();
    mocks.create.mockResolvedValue({ _tag: "Success", value: {} });
    mocks.importThreads.mockResolvedValue({
      _tag: "Success",
      value: { importedCount: 2, skippedCount: 0 },
    });
    mocks.candidates = ["one", "two"].map((id) => ({
      title: id,
      path: `/demo/${id}`,
      projectId: ProjectId.make(id),
      threadCount: 2,
      sources: ["codex"],
      lastActiveAt: new Date().toISOString(),
    }));
  });
  it("retains partial failures for retry and does not repeat completed projects", async () => {
    mocks.importThreads.mockResolvedValueOnce({
      _tag: "Success",
      value: { importedCount: 1, skippedCount: 1 },
    });
    expect((await render().run()).success).toBe(false);
    expect(render().selected.map((p) => p.title)).toEqual(["one"]);
    await render().run();
    expect(mocks.importThreads).toHaveBeenCalledTimes(3);
    expect(mocks.importThreads).toHaveBeenLastCalledWith({
      environmentId,
      input: { projectId: "one", expectedWorkspaceRoot: "/demo/one" },
    });
    expect(render().selected).toHaveLength(0);
  });
  it("allows explicitly selecting an imported project again to read newer history", async () => {
    await render().run();
    render().setSelected(new Set([render().candidates[0]!.key]));
    await render().run();
    expect(mocks.importThreads).toHaveBeenCalledTimes(3);
  });
  it("uses an existing project without creating a duplicate", async () => {
    await render().run();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("reuses the project creation identity when thread import needs a retry", async () => {
    mocks.candidates = [
      {
        title: "new",
        path: "/demo/new",
        threadCount: 2,
        sources: ["codex"],
        lastActiveAt: new Date().toISOString(),
      },
    ];
    mocks.importThreads.mockResolvedValueOnce({
      _tag: "Success",
      value: { importedCount: 0, skippedCount: 1 },
    });
    await render().run();
    await render().run();
    expect(mocks.create.mock.calls[1]?.[0].input.projectId).toBe(
      mocks.create.mock.calls[0]?.[0].input.projectId,
    );
    expect(mocks.create.mock.calls[1]?.[0].input.commandId).toBe(
      mocks.create.mock.calls[0]?.[0].input.commandId,
    );
  });
});
