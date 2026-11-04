import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import { useEffect, useImperativeHandle, type Ref } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { ComputerImporter, ComputerImportSummary } from "./types";

const environmentId = EnvironmentId.make("demo-laptop");
const landing: ScopedProjectRef = { environmentId, projectId: ProjectId.make("demo-project") };

const state = vi.hoisted(() => ({
  waitForProject: vi.fn(),
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [{ environmentId, label: "Demo laptop", connection: { phase: "connected" } }],
  })) as never,
  usePrimaryEnvironmentId: (() => environmentId) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  // The client's projects never include the imported project.
  useProjects: (() => []) as never,
  waitForProject: ((ref: ScopedProjectRef) => state.waitForProject(ref)) as never,
}));
vi.mock(import("./ImportComputer"), () => {
  function LegacyImportComputer({
    environmentId: id,
    onSummary,
    ref,
  }: {
    environmentId: EnvironmentId;
    onSummary: (id: EnvironmentId, summary: ComputerImportSummary) => void;
    ref: Ref<ComputerImporter>;
  }) {
    useEffect(() => {
      onSummary(id, {
        projects: 1,
        threads: 2,
        preferences: 0,
        preferenceChanges: 0,
        previewPending: false,
      });
    }, [id, onSummary]);
    useImperativeHandle(ref, () => ({
      run: async () => ({ success: true, projectRef: landing }),
    }));
    return null;
  }
  return { LegacyImportComputer, HistoryImportComputer: () => null };
});

import { DataImportPanel } from "./DataImportPanel";

function setup() {
  state.waitForProject.mockReset();
  return { onDone: vi.fn(async () => true) };
}

it("finishes setup without landing when the imported project never reaches the client", async () => {
  const { onDone } = setup();
  state.waitForProject.mockRejectedValue(new Error("The project did not appear."));
  await using screen = await render(<DataImportPanel source="legacy" onDone={onDone} />);

  await userEvent.click(screen.getByRole("button", { name: "Import & finish" }));

  await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  expect(onDone).toHaveBeenCalledWith(undefined);
});

it("lands in the imported project once it reaches the client", async () => {
  const { onDone } = setup();
  state.waitForProject.mockResolvedValue({});
  await using screen = await render(<DataImportPanel source="legacy" onDone={onDone} />);

  await userEvent.click(screen.getByRole("button", { name: "Import & finish" }));

  await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  expect(onDone).toHaveBeenCalledWith(landing);
  expect(state.waitForProject).toHaveBeenCalledWith(landing);
});
