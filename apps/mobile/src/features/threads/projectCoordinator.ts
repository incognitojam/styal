import { projectCoordinatorPatch } from "@t3tools/client-runtime/state/project-coordinators";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isListedThreadLineage } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";

/** The thread's coordinator menu item, while project coordinators are on in Labs. */
export function projectCoordinatorMenuItems(input: {
  readonly enabled: boolean;
  readonly isCoordinator: boolean;
  readonly thread: Pick<EnvironmentThreadShell, "lineage">;
}): MenuAction[] {
  if (!input.enabled || !isListedThreadLineage(input.thread.lineage)) return [];
  return input.isCoordinator
    ? [{ id: "stop-coordinator", title: "Stop being coordinator", image: "person.fill.xmark" }]
    : [{ id: "make-coordinator", title: "Make project coordinator", image: "person.badge.plus" }];
}

export async function setProjectCoordinator(
  thread: EnvironmentThreadShell,
  coordinate: boolean,
): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.updateSettings,
    {
      environmentId: thread.environmentId,
      input: { patch: projectCoordinatorPatch(thread.projectId, coordinate ? thread.id : null) },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(
      "Could not change the project coordinator",
      error instanceof Error ? error.message : "Try again.",
    );
  }
}
