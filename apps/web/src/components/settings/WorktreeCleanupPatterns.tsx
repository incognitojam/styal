import { useAtomValue } from "@effect/atom-react";
import {
  worktreeCleanupApprovalsFor,
  worktreeCleanupPatternList,
} from "@t3tools/client-runtime/state/worktreeCleanup";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronRightIcon, FolderIcon, HistoryIcon, Undo2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import { projectConfigRoot, useProjectConfigState } from "../../hooks/useProjectConfig";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { worktreeCleanup } from "../../state/worktreeCleanup";
import { reportHardwareResult } from "../hardware/reportHardwareResult";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

export function WorktreeCleanupPatternsSection() {
  const { scope, targets } = useSettingsScope();
  const { environments } = useEnvironments();
  if (scope.kind !== "project" && scope.kind !== "checkout") return null;
  return targets.map((target) => {
    const member = scope.members.find((member) => member.id === target.projectId);
    const environment = environments.find(
      (environment) => environment.environmentId === target.environmentId,
    );
    if (!member || !environment?.serverConfig?.environment.capabilities.worktreeCleanupPatterns)
      return null;
    return (
      <CheckoutCleanup
        key={`${target.environmentId}:${member.id}`}
        member={member}
        environmentId={target.environmentId}
        label={targets.length > 1 ? environment.label : null}
        approvals={worktreeCleanupApprovalsFor(environment.serverConfig.settings, member)}
      />
    );
  });
}

function CheckoutCleanup({
  member,
  environmentId,
  label,
  approvals,
}: {
  member: SidebarProjectGroupMember;
  environmentId: EnvironmentId;
  label: string | null;
  approvals: Readonly<Record<string, { readonly approvedAt: string }>> | undefined;
}) {
  const config = useProjectConfigState(environmentId, projectConfigRoot(member)).config;
  const list = worktreeCleanupPatternList(config?.worktreeCleanup, approvals);
  const approve = useAtomCommand(worktreeCleanup.approve, { reportFailure: false });
  const revoke = useAtomCommand(worktreeCleanup.revoke, { reportFailure: false });
  const canApprove = useAtomValue(worktreeCleanup.approve.permissionAtom(environmentId));
  const canRevoke = useAtomValue(worktreeCleanup.revoke.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const approvePattern = async (pattern: string) => {
    setBusy(true);
    const result = await approve({
      environmentId,
      input: { projectId: member.id, patterns: [pattern] },
    });
    setBusy(false);
    reportHardwareResult(result, "Could not approve the pattern");
  };
  const revokePattern = async (pattern: string | null) => {
    setBusy(true);
    const result = await revoke({ environmentId, input: { projectId: member.id, pattern } });
    setBusy(false);
    reportHardwareResult(result, "Could not revoke the approval");
  };
  return (
    <SettingsSection
      id="worktree-cleanup-patterns"
      title={label ? `Regenerable files on ${label}` : "Regenerable files"}
      forkFeature="worktree-declared-cleanup"
    >
      <div className="flex flex-col px-3 py-2 sm:px-4">
        <p className="pt-1 pb-2 text-xs text-muted-foreground">
          After a day of quiet, styal deletes git-ignored paths matching patterns you approve on
          this machine. The setup action runs again at the next turn.
        </p>
        {list.pending.length + list.approved.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">
            Declare regenerable paths in styal.json’s worktreeCleanup list to request approval here.
          </p>
        ) : null}
        {[...list.pending, ...list.approved].map((pattern) => (
          <div key={pattern} className="flex min-h-8 flex-wrap items-center gap-2">
            <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <code className="min-w-0 flex-1 font-mono text-xs break-all select-text">
              {pattern}
            </code>
            {list.pending.includes(pattern) ? (
              <>
                <Badge size="sm" variant="warning">
                  Needs approval
                </Badge>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || !canApprove}
                  onClick={() => void approvePattern(pattern)}
                >
                  Approve
                </Button>
              </>
            ) : (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Revoke approval for ${pattern}`}
                disabled={busy || !canRevoke}
                onClick={() => void revokePattern(pattern)}
              >
                <Undo2Icon />
              </Button>
            )}
          </div>
        ))}
        {list.earlier.length > 0 ? (
          <Collapsible open={earlierOpen} onOpenChange={setEarlierOpen}>
            <CollapsibleTrigger className="mt-1 flex min-h-8 w-full items-center gap-1.5 rounded-md text-left text-xs text-muted-foreground">
              <ChevronRightIcon aria-hidden className="size-3.5" />
              {list.earlier.length} approved earlier, not in styal.json
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <p className="pb-1 pl-5 text-xs text-muted-foreground">
                These patterns apply again without asking if styal.json lists them. Forget an
                approval to require approval again.
              </p>
              {list.earlier.map(({ pattern, approvedAt }) => (
                <div key={pattern} className="flex min-h-8 items-center gap-2 pl-5">
                  <HistoryIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <code className="min-w-0 flex-1 font-mono text-xs break-all select-text">
                    {pattern}
                  </code>
                  <span className="text-xs text-muted-foreground">
                    Approved{" "}
                    {new Date(approvedAt).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                    })}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Forget ${pattern}`}
                    disabled={busy || !canRevoke}
                    onClick={() => void revokePattern(pattern)}
                  >
                    <XIcon />
                  </Button>
                </div>
              ))}
            </CollapsiblePanel>
          </Collapsible>
        ) : null}
        {list.approved.length + list.earlier.length > 0 ? (
          <div className="flex justify-end pt-2">
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy || !canRevoke}
              onClick={() => void revokePattern(null)}
            >
              Revoke all
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
