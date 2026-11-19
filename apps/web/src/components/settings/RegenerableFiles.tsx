import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ProjectSettingsOverrides,
  WORKTREE_SOURCE_RELEASE_DAYS,
} from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";
import { useState } from "react";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { regenerableFiles } from "../../state/regenerableFiles";
import { useFeatureExplainer } from "../explainer/FeatureExplainerDialog";
import { reportHardwareResult } from "../hardware/reportHardwareResult";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { worktreeSourcesExplainer } from "./worktreeSourcesExplainer";

export function RegenerableFilesSection() {
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
        windows={environment.serverConfig.environment.platform.os === "windows"}
        machine={environment.label}
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
  windows,
  machine,
  overrides,
  migrationComplete,
}: {
  member: SidebarProjectGroupMember;
  environmentId: EnvironmentId;
  label: string | null;
  windows: boolean;
  machine: string;
  overrides: ProjectSettingsOverrides;
  migrationComplete: boolean;
}) {
  const patterns = useEnvironmentQuery(
    regenerableFiles.review({ environmentId, input: { projectId: member.id } }),
  );
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const canSave = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const releasing = !windows && overrides.releaseWorktreeSources === true;
  const explainer = useFeatureExplainer(
    worktreeSourcesExplainer,
    <>
      <span className="font-medium text-foreground">{releasing ? "On" : "Off"}</span> for{" "}
      {member.title} on {machine}.{" "}
      {releasing
        ? "Turn it off any time in the project's Worktrees settings."
        : "Turn it on in the project's Worktrees settings."}
    </>,
  );
  const update = async (
    key: "cleanRegenerableFiles" | "releaseWorktreeSources",
    checked: boolean,
  ) => {
    setBusy(true);
    const result = await save({
      environmentId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [member.id]: { ...overrides, [key]: checked },
          },
        },
      },
    });
    setBusy(false);
    return reportHardwareResult(result, "Could not save cleanup setting");
  };
  const unsupported = windows ? "Not available on Windows." : undefined;
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
            onCheckedChange={(checked) => void update("cleanRegenerableFiles", checked)}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("worktree-release-sources")}
        forkFeature="worktree-source-checkout"
        unsupported={unsupported}
        description={`Free unchanged sources after ${WORKTREE_SOURCE_RELEASE_DAYS} settled days on this machine. Keep local and ignored files; restore before use.`}
        status={windows ? undefined : explainer.link}
        control={
          <Switch
            aria-label="Free source files in settled worktrees"
            checked={releasing}
            disabled={busy || !canSave}
            onCheckedChange={async (checked) => {
              const saved = await update("releaseWorktreeSources", checked);
              if (saved && checked) explainer.onEnabled();
            }}
          />
        }
      />
      {explainer.dialog}
      <div className="flex flex-col gap-2 px-3 py-2 sm:px-4">
        {!migrationComplete && (
          <p role="status" className="text-xs text-muted-foreground">
            Cleanup is paused until saved settings finish migrating.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          <code>regenerableFiles</code> in styal.json from the last fetched origin default branch
          (the configured default or registered checkout’s branch without a remote):
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
          <p className="text-xs text-muted-foreground">
            No regenerableFiles patterns declared in styal.json.
          </p>
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
