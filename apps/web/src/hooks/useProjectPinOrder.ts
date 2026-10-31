import {
  nextProjectPinOrderKey,
  planProjectPinReorder,
} from "@t3tools/client-runtime/state/project-organization";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";

import { toastManager } from "../components/ui/toast";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import {
  reportProjectFailure,
  useProjectGroupUpdate,
  type ProjectGroupUpdate,
} from "./useProjectGroupUpdate";

type OrganizedGroup = Pick<
  SidebarProjectSnapshot,
  "projectKey" | "displayName" | "memberProjects" | "pinnedAt" | "pinOrderKey"
>;
type GroupResult = AtomCommandResult<void, unknown>;

// The newest pin slot handed out. Pins made faster than the list updates
// still land in click order instead of sharing one slot.
let lastIssuedPinOrderKey: string | null = null;

function issuePinOrderKey(groups: ReadonlyArray<OrganizedGroup>): string | null {
  const key = nextProjectPinOrderKey(
    lastIssuedPinOrderKey === null
      ? groups
      : [...groups, { pinnedAt: "issued", pinOrderKey: lastIssuedPinOrderKey }],
  );
  if (key !== null) lastIssuedPinOrderKey = key;
  return key;
}

/** Writes behind the grouped sidebar's project headers, which keep a shared order for pins. */
export function useProjectPinOrder() {
  const { updateProjectGroup, canOrganizeProjectGroup } = useProjectGroupUpdate();

  // Older servers drop pin and archive fields, so a header drag refuses instead
  // of writing to only some machines.
  const organize = async (
    group: OrganizedGroup,
    input: ProjectGroupUpdate,
    failureTitle: string,
  ): Promise<GroupResult> => {
    if (canOrganizeProjectGroup(group.memberProjects)) {
      return updateProjectGroup(group.memberProjects, input, failureTitle);
    }
    const result: GroupResult = AsyncResult.failure(
      Cause.fail(new Error("Update every machine with this project to pin and archive it.")),
    );
    reportProjectFailure(failureTitle, result);
    return result;
  };

  const setProjectPinned = (
    group: OrganizedGroup,
    pinned: boolean,
    groups: ReadonlyArray<OrganizedGroup>,
  ) =>
    organize(
      group,
      pinned ? { pinned: true, pinOrderKey: issuePinOrderKey(groups) } : { pinned: false },
      pinned ? `Failed to pin ${group.displayName}` : `Failed to unpin ${group.displayName}`,
    );

  /** Saves a dragged order of the pinned projects. */
  const reorderPinnedProjects = async (
    orderedGroups: ReadonlyArray<OrganizedGroup>,
    movedKey: string,
  ): Promise<GroupResult> => {
    const groupByKey = new Map(orderedGroups.map((group) => [group.projectKey, group]));
    const writes = planProjectPinReorder({
      orderedKeys: orderedGroups.map((group) => group.projectKey),
      pinOrderKeyByKey: new Map(
        orderedGroups.map((group) => [group.projectKey, group.pinOrderKey ?? null]),
      ),
      movedKey,
    });
    for (const write of writes) {
      const group = groupByKey.get(write.key);
      if (!group) continue;
      const result = await organize(
        group,
        { pinned: true, pinOrderKey: write.pinOrderKey },
        "Failed to reorder pinned projects",
      );
      if (result._tag === "Failure") return result;
    }
    return AsyncResult.success(undefined);
  };

  /** Archives from the header menu with an Undo toast, since the way back is in Settings. */
  const archiveProject = async (group: OrganizedGroup): Promise<GroupResult> => {
    const result = await organize(
      group,
      { archived: true },
      `Failed to archive ${group.displayName}`,
    );
    if (result._tag === "Success") {
      const toastId = toastManager.add({
        type: "success",
        title: `Archived ${group.displayName}`,
        description: "It leaves project pickers. Unarchive it in Settings → Projects.",
        timeout: 5_000,
        actionProps: {
          children: "Undo",
          onClick: () => {
            toastManager.close(toastId);
            void organize(group, { archived: false }, `Failed to unarchive ${group.displayName}`);
          },
        },
        data: { hideCopyButton: true },
      });
    }
    return result;
  };

  return { setProjectPinned, reorderPinnedProjects, archiveProject };
}
