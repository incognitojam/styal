import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../../test/render";
import type { ImportOutcome } from "./types";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  importThreads: vi.fn(),
  refresh: vi.fn(),
  canOperate: true,
  candidates: [] as Array<{
    title: string;
    path: string;
    projectId?: ProjectId;
    threadCount: number;
    sources: ("codex" | "claudeAgent")[];
    lastActiveAt: string;
    git: { remoteKey: string | null; repository: string | null } | null;
  }>,
}));
vi.mock(import("../../onboarding/useProjectScans"), async (original) => ({
  ...(await original()),
  useProjectScans: ((ids: EnvironmentId[]) => [
    {
      environmentId: ids[0],
      data: { candidates: mocks.candidates },
      error: null,
      isPending: false,
      refresh: mocks.refresh,
    },
  ]) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => mocks.canOperate,
  readEnvironmentScope: () => mocks.canOperate,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const { projectEnvironment } = await import("../../state/projects");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === projectEnvironment.create ? mocks.create : mocks.importThreads) as never,
  };
});
import { useHistoryImport } from "./useHistoryImport";
const environmentId = EnvironmentId.make("demo-desktop");
// Candidates active at this instant fall inside the recent window, so they start selected.
const LAST_ACTIVE_AT = "2026-07-02T00:00:00.000Z";
function setup() {
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(LAST_ACTIVE_AT));
  mocks.create.mockReset();
  mocks.importThreads.mockReset();
  mocks.canOperate = true;
  mocks.create.mockResolvedValue({ _tag: "Success", value: {} });
  mocks.importThreads.mockResolvedValue({
    _tag: "Success",
    value: { importedCount: 2, skippedCount: 0 },
  });
  mocks.candidates = ["one", "two"].map((id) => ({
    title: id,
    path: `/demo/${id}`,
    projectId: ProjectId.make(id),
    threadCount: 3,
    sources: ["codex"],
    lastActiveAt: LAST_ACTIVE_AT,
    git: { remoteKey: null, repository: null },
  }));
  let current!: ReturnType<typeof useHistoryImport>;
  function Probe() {
    const importer = useHistoryImport(environmentId);
    useEffect(() => {
      current = importer;
    });
    return null;
  }
  let screen: Screen | undefined;
  const renderProbe = async () => {
    if (screen) await screen.rerender(<Probe />);
    else screen = await render(<Probe />);
    return current;
  };
  return {
    render: renderProbe,
    run: async () => {
      const importer = await renderProbe();
      return act(() => importer.run());
    },
    [Symbol.asyncDispose]: async () => {
      await screen?.[Symbol.asyncDispose]();
      now.mockRestore();
    },
  };
}
describe("setup CLI history importer", () => {
  it("retains partial failures for retry and does not repeat completed projects", async () => {
    await using app = setup();
    mocks.importThreads.mockResolvedValueOnce({
      _tag: "Success",
      value: { importedCount: 1, skippedCount: 1 },
    });
    expect((await app.run()).success).toBe(false);
    expect((await app.render()).selected.map((p) => p.title)).toEqual(["one"]);
    await app.run();
    expect(mocks.importThreads).toHaveBeenCalledTimes(3);
    expect(mocks.importThreads).toHaveBeenLastCalledWith({
      environmentId,
      input: { projectId: "one", expectedWorkspaceRoot: "/demo/one" },
    });
    expect((await app.render()).selected).toHaveLength(0);
  });
  it("allows explicitly selecting an imported project again to read newer history", async () => {
    await using app = setup();
    await app.run();
    const importer = await app.render();
    await act(() => importer.setSelected(new Set([importer.candidates[0]!.key])));
    await app.run();
    expect(mocks.importThreads).toHaveBeenCalledTimes(3);
  });
  it("uses an existing project without creating a duplicate", async () => {
    await using app = setup();
    await app.run();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("reuses the project creation identity when thread import needs a retry", async () => {
    await using app = setup();
    mocks.candidates = [
      {
        title: "new",
        path: "/demo/new",
        threadCount: 3,
        sources: ["codex"],
        lastActiveAt: LAST_ACTIVE_AT,
        git: { remoteKey: null, repository: null },
      },
    ];
    mocks.importThreads.mockResolvedValueOnce({
      _tag: "Success",
      value: { importedCount: 0, skippedCount: 1 },
    });
    await app.run();
    await app.run();
    expect(mocks.create.mock.calls[1]?.[0].input.projectId).toBe(
      mocks.create.mock.calls[0]?.[0].input.projectId,
    );
    expect(mocks.create.mock.calls[1]?.[0].input.commandId).toBe(
      mocks.create.mock.calls[0]?.[0].input.commandId,
    );
  });
  it("keeps the selection and writes nothing without permission to operate the environment", async () => {
    await using app = setup();
    mocks.canOperate = false;
    expect((await app.run()).success).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.importThreads).not.toHaveBeenCalled();
    expect((await app.render()).error).toBe(
      "This connection cannot import projects or thread history.",
    );
    expect((await app.render()).selected).toHaveLength(2);
  });
  it("stops before importing history when permission is revoked and retries with the same project", async () => {
    await using app = setup();
    mocks.candidates = [
      {
        title: "new",
        path: "/demo/new",
        threadCount: 3,
        sources: ["codex"],
        lastActiveAt: LAST_ACTIVE_AT,
        git: { remoteKey: null, repository: null },
      },
    ];
    mocks.create.mockImplementationOnce(async () => {
      mocks.canOperate = false;
      return { _tag: "Success", value: {} };
    });
    expect((await app.run()).success).toBe(false);
    expect(mocks.importThreads).not.toHaveBeenCalled();
    mocks.canOperate = true;
    expect((await app.render()).error).toBe("");
    expect((await app.run()).success).toBe(true);
    expect(mocks.importThreads).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[1]?.[0].input.commandId).toBe(
      mocks.create.mock.calls[0]?.[0].input.commandId,
    );
  });
  it("shows queued and active projects until each command confirms its result", async () => {
    await using app = setup();
    type Receipt = { _tag: "Success"; value: { importedCount: number; skippedCount: number } };
    let completeFirst!: (receipt: Receipt) => void;
    let completeSecond!: (receipt: Receipt) => void;
    const first = new Promise<Receipt>((resolve) => {
      completeFirst = resolve;
    });
    const second = new Promise<Receipt>((resolve) => {
      completeSecond = resolve;
    });
    mocks.importThreads.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const importer = await app.render();
    let running!: Promise<ImportOutcome>;
    await act(async () => {
      running = importer.run();
    });
    expect((await app.render()).progress?.map((row) => row.status)).toEqual([
      "importing",
      "queued",
    ]);
    await act(async () => {
      completeFirst({ _tag: "Success", value: { importedCount: 2, skippedCount: 0 } });
      await first;
    });
    expect((await app.render()).progress?.map((row) => row.status)).toEqual([
      "complete",
      "importing",
    ]);
    const outcome = await act(async () => {
      completeSecond({ _tag: "Success", value: { importedCount: 1, skippedCount: 1 } });
      return running;
    });
    expect(outcome.success).toBe(false);
    expect((await app.render()).progress).toMatchObject([
      { title: "one", status: "complete", importedCount: 2 },
      { title: "two", status: "failed", importedCount: 1, skippedCount: 1 },
    ]);
    expect((await app.render()).selected.map((project) => project.title)).toEqual(["two"]);
  });
  it("marks a rejected command as failed and continues the remaining projects", async () => {
    await using app = setup();
    mocks.importThreads.mockRejectedValueOnce(new Error("Connection lost"));
    expect((await app.run()).success).toBe(false);
    expect((await app.render()).progress?.map((row) => row.status)).toEqual(["failed", "complete"]);
    expect((await app.render()).selected.map((project) => project.title)).toEqual(["one"]);
  });
});
