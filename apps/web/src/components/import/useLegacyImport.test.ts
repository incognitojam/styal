import { EnvironmentId, type LegacyImportPreview } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { selectLegacyImportPreferences } from "../settings/DataImportSettings.logic";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  query: {
    data: null as LegacyImportPreview | null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  },
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
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => mocks.query }));
vi.mock("../../state/dataImport", () => ({ importLegacyData: {}, legacyImportPreview: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.command }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (_id: unknown, select: typeof selectLegacyImportPreferences) =>
    select(DEFAULT_SERVER_SETTINGS),
}));
import { useLegacyImport } from "./useLegacyImport";
const environmentId = EnvironmentId.make("demo-laptop");
const render = (busy = false) => {
  hooks.beginRender();
  return useLegacyImport(environmentId, busy);
};
const project = (projectId: string) => ({
  projectId,
  title: projectId,
  workspaceRoot: `/demo/${projectId}`,
  faviconPath: null,
  threadCount: 2,
  contextRepairCount: 0,
  scriptCount: 0,
  isExistingProject: false,
});
const result = (failed: string[] = []) => ({
  _tag: "Success",
  value: {
    sourceKind: "t3-code",
    projects: ["one", "two"].map((id) => ({
      sourceProjectId: id,
      targetProjectId: id,
      title: id,
      status: failed.includes(id) ? "failed" : "imported",
      threadCount: 2,
      repairedThreadCount: 0,
      skippedAttachmentCount: 0,
    })),
    importedProjectCount: 2 - failed.length,
    importedThreadCount: 4,
    repairedThreadCount: 0,
    skippedAttachmentCount: 0,
  },
});
describe("shared T3 importer", () => {
  beforeEach(() => {
    hooks.reset();
    mocks.command.mockReset();
    mocks.query.refresh.mockClear();
    mocks.query.data = {
      status: "available",
      sourceKind: "t3-code",
      schemaVersion: 1,
      projects: [project("one"), project("two")],
      preferences: {
        status: "available",
        values: {
          ...selectLegacyImportPreferences(DEFAULT_SERVER_SETTINGS),
          enableAgentBrowserAccess: !DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess,
        },
      },
    };
    mocks.command.mockResolvedValue(result());
  });
  it("imports selected projects without implicitly applying preferences", async () => {
    const importer = render();
    expect(importer.selectedPreferences).toBe(false);
    await importer.run();
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { projectIds: ["one", "two"], includeSettings: false },
    });
    expect(render().selected).toHaveLength(0);
  });
  it("keeps only failed projects selected and retries those", async () => {
    mocks.command.mockResolvedValueOnce(result(["two"]));
    expect((await render().run()).success).toBe(false);
    const retry = render();
    expect(retry.selected.map((p) => p.projectId)).toEqual(["two"]);
    await retry.run();
    expect(mocks.command).toHaveBeenLastCalledWith({
      environmentId,
      input: { projectIds: ["two"], includeSettings: false },
    });
  });
  it("runs opted-in preferences independently after a partial project import", async () => {
    render().setIncludeSettings(true);
    mocks.command.mockResolvedValueOnce(result(["two"])).mockResolvedValueOnce({
      _tag: "Success",
      value: { ...result().value, projects: [], settings: { status: "imported" } },
    });
    expect((await render().run()).success).toBe(false);
    expect(mocks.command).toHaveBeenLastCalledWith({
      environmentId,
      input: { projectIds: [], includeSettings: true },
    });
    expect(render().selectedPreferences).toBe(false);
  });
  it("retains opted-in preferences when their import fails", async () => {
    const importer = render();
    importer.setSelection(new Set());
    importer.setIncludeSettings(true);
    mocks.command.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        ...result().value,
        projects: [],
        settings: { status: "failed", detail: "Disk is full" },
      },
    });
    expect((await render().run()).success).toBe(false);
    expect(render().preferencesError).toBe("Disk is full");
    expect(render().selectedPreferences).toBe(true);
  });
  it("keeps the reviewed preview stable while a poll changes during import", () => {
    const original = render().preview;
    mocks.query.data = { status: "not-found" };
    expect(render(true).preview).toBe(original);
    expect(render(false).preview).toEqual({ status: "not-found" });
  });
  it("keeps the batch visible through project, preference, and completion receipts", async () => {
    render().setIncludeSettings(true);
    let completeProjects!: (value: ReturnType<typeof result>) => void;
    let completePreferences!: (value: unknown) => void;
    mocks.command
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeProjects = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completePreferences = resolve;
          }),
      );
    const running = render().run();
    expect(render(true).progress).toMatchObject({ phase: "projects", preferences: "queued" });
    mocks.query.data = {
      status: "available",
      sourceKind: "t3-code",
      schemaVersion: 1,
      projects: [project("two")],
    };
    expect(render(true).progress?.projects.map((p) => p.projectId)).toEqual(["one", "two"]);
    expect(render(true).query.data).toBe(mocks.query.data);
    completeProjects(result());
    await Promise.resolve();
    expect(render(true).progress).toMatchObject({
      phase: "preferences",
      preferences: "importing",
      result: result().value,
    });
    completePreferences({
      _tag: "Success",
      value: { ...result().value, projects: [], settings: { status: "imported" } },
    });
    await running;
    expect(render(true).progress).toMatchObject({ phase: "done", preferences: "complete" });
  });
  it("does not mark a failed import complete when its preview becomes empty", async () => {
    mocks.command.mockResolvedValueOnce(result(["two"]));
    await render().run();
    mocks.query.data = {
      status: "available",
      sourceKind: "t3-code",
      schemaVersion: 1,
      projects: [],
    };
    expect(
      render(true).progress?.result?.projects.find((p) => p.sourceProjectId === "two")?.status,
    ).toBe("failed");
  });
});
