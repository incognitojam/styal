import { EnvironmentId, type LegacyImportPreview } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { selectLegacyImportPreferences } from "../settings/DataImportSettings.logic";
import type { ImportOutcome } from "./types";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  query: {
    data: null as LegacyImportPreview | null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  },
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => mocks.query) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => mocks.command) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((_id: unknown, select: typeof selectLegacyImportPreferences) =>
    select(DEFAULT_SERVER_SETTINGS)) as never,
}));
import { useLegacyImport } from "./useLegacyImport";
const environmentId = EnvironmentId.make("demo-laptop");
let root: Root;
let current: ReturnType<typeof useLegacyImport>;
function Probe({ busy }: { busy: boolean }) {
  const importer = useLegacyImport(environmentId, busy);
  useEffect(() => {
    current = importer;
  });
  return null;
}
const render = async (busy = false) => {
  await act(() => root.render(<Probe busy={busy} />));
  return current;
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
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
    mocks.command.mockImplementation(async ({ input }) =>
      input.includeSettings
        ? {
            _tag: "Success",
            value: { ...result().value, projects: [], settings: { status: "imported" } },
          }
        : result(),
    );
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  });
  it("imports differing preferences by default with a separate request", async () => {
    const importer = await render();
    expect(importer.selectedPreferences).toBe(true);
    await act(() => importer.run());
    expect(mocks.command.mock.calls.map(([request]) => request.input)).toEqual([
      { projectIds: ["one", "two"], includeSettings: false },
      { projectIds: [], includeSettings: true },
    ]);
    expect((await render()).selected).toHaveLength(0);
    expect((await render()).selectedPreferences).toBe(false);
  });
  it("preserves an opt-out when preview data refreshes", async () => {
    const initial = await render();
    await act(() => initial.setIncludeSettings(false));
    mocks.query.data = structuredClone(mocks.query.data);
    const importer = await render();
    expect(importer.selectedPreferences).toBe(false);
    await act(() => importer.run());
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { projectIds: ["one", "two"], includeSettings: false },
    });
  });
  it("selects preferences when discovery finishes, but not when values already match", async () => {
    const available = mocks.query.data;
    mocks.query.data = null;
    expect((await render()).selectedPreferences).toBe(false);
    mocks.query.data = available;
    expect((await render()).selectedPreferences).toBe(true);
    mocks.query.data = {
      status: "available",
      sourceKind: "t3-code",
      schemaVersion: 1,
      projects: [],
      preferences: {
        status: "available",
        values: selectLegacyImportPreferences(DEFAULT_SERVER_SETTINGS),
      },
    };
    expect((await render()).selectedPreferences).toBe(false);
  });
  it("keeps only failed projects selected and retries those", async () => {
    mocks.command.mockResolvedValueOnce(result(["two"]));
    const importer = await render();
    expect((await act(() => importer.run())).success).toBe(false);
    const retry = await render();
    expect(retry.selected.map((p) => p.projectId)).toEqual(["two"]);
    await act(() => retry.run());
    expect(mocks.command).toHaveBeenLastCalledWith({
      environmentId,
      input: { projectIds: ["two"], includeSettings: false },
    });
  });
  it("runs selected preferences independently after a partial project import", async () => {
    const initial = await render();
    await act(() => initial.setIncludeSettings(true));
    mocks.command.mockResolvedValueOnce(result(["two"])).mockResolvedValueOnce({
      _tag: "Success",
      value: { ...result().value, projects: [], settings: { status: "imported" } },
    });
    const importer = await render();
    expect((await act(() => importer.run())).success).toBe(false);
    expect(mocks.command).toHaveBeenLastCalledWith({
      environmentId,
      input: { projectIds: [], includeSettings: true },
    });
    expect((await render()).selectedPreferences).toBe(false);
  });
  it("retains selected preferences when their import fails", async () => {
    const importer = await render();
    await act(() => {
      importer.setSelection(new Set());
      importer.setIncludeSettings(true);
    });
    mocks.command.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        ...result().value,
        projects: [],
        settings: { status: "failed", detail: "Disk is full" },
      },
    });
    const retry = await render();
    expect((await act(() => retry.run())).success).toBe(false);
    expect((await render()).preferencesError).toBe("Disk is full");
    expect((await render()).selectedPreferences).toBe(true);
  });
  it("keeps the reviewed preview stable while a poll changes during import", async () => {
    const original = (await render()).preview;
    mocks.query.data = { status: "not-found" };
    expect((await render(true)).preview).toBe(original);
    expect((await render(false)).preview).toEqual({ status: "not-found" });
  });
  it("keeps the batch visible through project, preference, and completion receipts", async () => {
    const initial = await render();
    await act(() => initial.setIncludeSettings(true));
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
    const importer = await render();
    let running!: Promise<ImportOutcome>;
    await act(async () => {
      running = importer.run();
    });
    expect((await render(true)).progress).toMatchObject({
      phase: "projects",
      preferences: "queued",
    });
    mocks.query.data = {
      status: "available",
      sourceKind: "t3-code",
      schemaVersion: 1,
      projects: [project("two")],
    };
    expect((await render(true)).progress?.projects.map((p) => p.projectId)).toEqual(["one", "two"]);
    expect((await render(true)).query.data).toBe(mocks.query.data);
    await act(async () => {
      completeProjects(result());
    });
    expect((await render(true)).progress).toMatchObject({
      phase: "preferences",
      preferences: "importing",
      result: result().value,
    });
    await act(async () => {
      completePreferences({
        _tag: "Success",
        value: { ...result().value, projects: [], settings: { status: "imported" } },
      });
      await running;
    });
    expect((await render(true)).progress).toMatchObject({ phase: "done", preferences: "complete" });
  });
  it("does not mark a failed import complete when its preview becomes empty", async () => {
    mocks.command.mockResolvedValueOnce(result(["two"]));
    const importer = await render();
    await act(() => importer.run());
    mocks.query.data = {
      status: "available",
      sourceKind: "t3-code",
      schemaVersion: 1,
      projects: [],
    };
    expect(
      (await render(true)).progress?.result?.projects.find((p) => p.sourceProjectId === "two")
        ?.status,
    ).toBe("failed");
  });
  it("imports preferences without importing the default T3 project selection", async () => {
    const initial = await render();
    await act(() => initial.setIncludeSettings(true));
    mocks.command.mockResolvedValueOnce({
      _tag: "Success",
      value: { ...result().value, projects: [], settings: { status: "imported" } },
    });
    const importer = await render();
    const outcome = await act(() => importer.run({ includeProjects: false }));
    expect(outcome).toEqual({ success: true, projectRef: undefined });
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { projectIds: [], includeSettings: true },
    });
    expect((await render()).selected).toHaveLength(2);
    expect((await render()).selectedPreferences).toBe(false);
    expect((await render(true)).progress?.projects).toHaveLength(0);
  });
  it("imports projects without the selected preferences when preferences are left for later", async () => {
    const importer = await render();
    const outcome = await act(() => importer.run({ includePreferences: false }));
    expect(outcome.success).toBe(true);
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { projectIds: ["one", "two"], includeSettings: false },
    });
    expect((await render()).selectedPreferences).toBe(true);
    expect((await render(true)).progress?.preferences).toBeNull();
  });
  it("does not import anything when projects are skipped and preferences are not selected", async () => {
    const initial = await render();
    await act(() => initial.setIncludeSettings(false));
    const importer = await render();
    expect(await act(() => importer.run({ includeProjects: false }))).toEqual({
      success: true,
      projectRef: undefined,
    });
    expect(mocks.command).not.toHaveBeenCalled();
    expect((await render()).selected).toHaveLength(2);
  });
});
