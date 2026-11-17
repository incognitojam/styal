import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectSettingsOverrides } from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";
import { useState } from "react";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { worktreeCleanup } from "../../state/worktreeCleanup";
import { reportHardwareResult } from "../hardware/reportHardwareResult";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

export function WorktreeCleanupPatternsSection() {
  const { scope, targets } = useSettingsScope();
  const { environments } = useEnvironments();
  if (scope.kind !== "project" && scope.kind !== "checkout") return null;
  return targets.map((target) => {
    const member = scope.members.find(
      (member) => member.id === target.projectId && member.environmentId === target.environmentId,
    );
    const environment = environments.find(
      (environment) => environment.environmentId === target.environmentId,
    );
    if (!member || !environment?.serverConfig?.environment.capabilities.regenerableFileCleanup)
      return null;
    return (
      <CheckoutCleanup
        key={`${target.environmentId}:${member.id}`}
        member={member}
        environmentId={target.environmentId}
        label={targets.length > 1 ? environment.label : null}
        overrides={environment.serverConfig.settings.projectSettingsOverrides[member.id] ?? {}}
        migrationComplete={environment.serverConfig.settings.regenerableFileCleanupMigrated}
      />
    );
  });
}

function CheckoutCleanup({
  member,
  environmentId,
  label,
  overrides,
  migrationComplete,
}: {
  member: SidebarProjectGroupMember;
  environmentId: EnvironmentId;
  label: string | null;
  overrides: ProjectSettingsOverrides;
  migrationComplete: boolean;
}) {
  const patterns = useEnvironmentQuery(
    worktreeCleanup.review({ environmentId, input: { projectId: member.id } }),
  );
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const canSave = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const update = async (checked: boolean) => {
    setBusy(true);
    const result = await save({
      environmentId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [member.id]: { ...overrides, cleanRegenerableFiles: checked },
          },
        },
      },
    });
    setBusy(false);
    reportHardwareResult(result, "Could not save cleanup setting");
  };
  return (
    <SettingsSection title={label ? `Regenerable files on ${label}` : "Regenerable files"}>
      <SettingsRow
        {...searchableSetting("worktree-clean-regenerable-files")}
        forkFeature="worktree-declared-cleanup"
        description="Delete matching git-ignored paths in settled worktrees on this machine, at least 24 hours after the last thread activity, settlement or archival. The next turn reruns setup."
        control={
          <Switch
            aria-label="Clean up regenerable files"
            checked={migrationComplete && overrides.cleanRegenerableFiles !== false}
            disabled={busy || !canSave || !migrationComplete}
            onCheckedChange={(checked) => void update(checked)}
          />
        }
      />
      <div className="flex flex-col gap-2 px-3 py-2 sm:px-4">
        {!migrationComplete && (
          <p role="status" className="text-xs text-muted-foreground">
            Cleanup is paused until saved settings finish migrating.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Patterns from the last fetched origin default branch (the configured default or registered
          checkout’s branch without a remote):
        </p>
        {patterns.error ? (
          <p role="alert" className="text-xs text-muted-foreground">
            {patterns.error}
          </p>
        ) : patterns.data === null ? (
          <p className="text-xs text-muted-foreground">Loading patterns…</p>
        ) : patterns.data.unavailableReason ? (
          <p role="status" className="text-xs text-muted-foreground">
            {patterns.data.unavailableReason}
          </p>
        ) : patterns.data.patterns.length === 0 ? (
          <p className="text-xs text-muted-foreground">No cleanup patterns declared.</p>
        ) : (
          [...new Set(patterns.data.patterns)].map((pattern) => (
            <div key={pattern} className="flex items-center gap-2">
              <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <code className="font-mono text-xs break-all select-text">{pattern}</code>
            </div>
          ))
        )}
      </div>
    </SettingsSection>
  );
}
