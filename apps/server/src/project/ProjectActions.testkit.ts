import type { ProjectAction, ProjectActionsResult, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectActions from "./ProjectActions.ts";

export const actionsResult = (actions: readonly ProjectAction[] = []): ProjectActionsResult => ({
  source: { kind: "disk" },
  actions,
  policyAllowed: true,
  approvedCommands: actions.filter((action) => action.approved).map((action) => action.command),
  unmerged: false,
  changedNames: [],
});

export const layerActions = (actions: readonly ProjectAction[] = [], projectId?: ProjectId) =>
  Layer.mock(ProjectActions.ProjectActions)({
    read: (input) =>
      Effect.succeed(
        actionsResult(projectId === undefined || input.projectId === projectId ? actions : []),
      ),
  });
