import { projectCoordinatorPatch } from "@t3tools/client-runtime/state/project-coordinators";
import {
  AuthSettingsWriteScope,
  isListedThreadLineage,
  projectCoordinatorThreadId,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import { reportProjectCoordinatorFailure } from "../../hooks/useThreadActionMenu";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";

const NONE = "none";

/** Picks the project's coordinator on each machine where project coordinators are on in Labs. */
export function ProjectCoordinatorSetting({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const serverConfigs = useServerConfigs();
  const threads = useThreadShells();
  const writableIds = useEnvironmentsWithScope(members, AuthSettingsWriteScope);
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const enabledMembers = members.filter(
    (member) =>
      serverConfigs.get(member.environmentId)?.settings.projectCoordinatorsEnabled === true,
  );
  if (enabledMembers.length === 0) return null;

  const memberKeys = new Set(
    enabledMembers.map((member) => `${member.environmentId}:${member.id}`),
  );
  const candidates = threads
    .filter(
      (thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`) &&
        thread.archivedAt === null &&
        isListedThreadLineage(thread.lineage),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const current = enabledMembers.flatMap((member) => {
    const settings = serverConfigs.get(member.environmentId)?.settings;
    const threadId = settings ? projectCoordinatorThreadId(settings, member.id) : null;
    return threadId === null ? [] : [`${member.environmentId}:${threadId}`];
  })[0];
  const value = current ?? NONE;
  const titleByKey = new Map<string, string>(
    candidates.map((thread) => [`${thread.environmentId}:${thread.id}`, thread.title] as const),
  );

  // One coordinator per project: picking a thread clears the other checkouts' coordinators.
  const choose = async (next: string) => {
    if (next === value) return;
    setBusy(true);
    for (const member of enabledMembers) {
      const chosen = candidates.find(
        (thread) =>
          `${thread.environmentId}:${thread.id}` === next &&
          thread.environmentId === member.environmentId &&
          thread.projectId === member.id,
      );
      const threadId: ThreadId | null = chosen?.id ?? null;
      const settings = serverConfigs.get(member.environmentId)?.settings;
      const saved = settings ? projectCoordinatorThreadId(settings, member.id) : null;
      if (saved === threadId) continue;
      await reportProjectCoordinatorFailure(
        await save({
          environmentId: member.environmentId,
          input: { patch: projectCoordinatorPatch(member.id, threadId) },
        }),
      );
    }
    setBusy(false);
  };

  return (
    <SettingsRow
      title="Coordinator"
      forkFeature="project-coordinators"
      description="A thread that hands work to other threads. Threads started in this project report to it when they finish or need input."
      control={
        <div className="w-full sm:w-64">
          <Select
            value={value}
            disabled={
              busy || !enabledMembers.every((member) => writableIds.has(member.environmentId))
            }
            onValueChange={(next) => {
              if (typeof next === "string") void choose(next);
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Project coordinator">
              <SelectValue>
                {value === NONE ? "None" : (titleByKey.get(value) ?? "Unknown thread")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={NONE}>None</SelectItem>
              {candidates.map((thread) => (
                <SelectItem
                  key={`${thread.environmentId}:${thread.id}`}
                  value={`${thread.environmentId}:${thread.id}`}
                >
                  {thread.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}
