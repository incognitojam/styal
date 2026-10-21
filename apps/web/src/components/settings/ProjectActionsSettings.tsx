import { useScopedSettingsWriteAllowed } from "./useScopedSettings";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { EnvironmentId, type T3ProjectFileScript } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { projectFileApprovalKey } from "@t3tools/shared/projectFileApprovals";
import {
  mergeProjectActions,
  projectScriptMenuLabel,
  type ResolvedProjectAction,
} from "@t3tools/shared/projectScripts";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { projectConfigRoot, useProjectConfigState } from "../../hooks/useProjectConfig";
import { useEnvironments } from "../../state/environments";
import {
  FileActionApprovalDialog,
  type FileActionApprovalTarget,
} from "../FileActionApprovalDialog";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForFileScript,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  ScriptIcon,
  type ProjectScriptEditorRequest,
} from "../projectScriptEditor";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ProjectActionsList } from "./ProjectActionsList";
import { useProjectScriptSettings } from "./useProjectScriptSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

/**
 * A project's actions on each selected environment. Actions belong to a
 * project, so this only renders at a project scope; the environment's
 * `defaultProjectScripts` is the layer a project without its own list
 * inherits. Shortcuts are environment-wide, so the same action id shares its
 * binding on an environment.
 */
export function ProjectActionsSettings() {
  const { scope, targets, target } = useSettingsScope();
  const { environments } = useEnvironments();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const representativeConfig = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
        ?.serverConfig
    : undefined;
  const scripts = target?.settings.defaultProjectScripts ?? [];
  const keybindings = representativeConfig?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const mixed = targets.some(
    (candidate) =>
      JSON.stringify(candidate.settings.defaultProjectScripts) !== JSON.stringify(scripts),
  );
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const [request, setRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const memberById = new Map(
    isProjectScope ? scope.members.map((member) => [member.id, member]) : [],
  );
  const { saving, persist, submit } = useProjectScriptSettings(
    targets.flatMap((candidate) => {
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
      if (!environment?.serverConfig) return [];
      const member = candidate.projectId ? memberById.get(candidate.projectId) : undefined;
      // An older server ignores the override record, so a project edit there
      // would report success and vanish; such environments are left out and
      // the legacy per-project map keeps serving them.
      if (
        member &&
        environment.serverConfig.environment?.capabilities.projectSettingsOverrides !== true
      ) {
        return [];
      }
      return [
        {
          environmentId: candidate.environmentId,
          // Writes read the raw environment settings so an override entry is
          // extended, not derived from already-resolved values.
          settings: environment.serverConfig.settings,
          keybindings: environment.serverConfig.keybindings,
          ...(member ? { project: member } : {}),
        },
      ];
    }),
  );

  // The project file's actions are listed alongside the saved ones, and a
  // legacy t3.json can declare actions to import; a styal.json hides it.
  // Read it from the representative member; edits still fan out.
  const representativeMember = target?.projectId ? memberById.get(target.projectId) : undefined;
  const projectConfig = useProjectConfigState(
    representativeMember?.environmentId ?? EnvironmentId.make("none"),
    representativeMember ? projectConfigRoot(representativeMember) : null,
  );
  const approvals = representativeMember
    ? representativeConfig?.settings.projectFileActionApprovals[
        projectFileApprovalKey(representativeMember)
      ]
    : undefined;
  const actions = useMemo(
    () =>
      mergeProjectActions(scripts, isProjectScope ? projectConfig.config : null, approvals ?? {}),
    [approvals, isProjectScope, projectConfig.config, scripts],
  );
  const [reviewing, setReviewing] = useState<FileActionApprovalTarget | null>(null);
  const fileActionIds = useMemo(
    () => actions.filter((action) => action.source !== "local").map((action) => action.id),
    [actions],
  );
  const importableScripts = useMemo(
    () =>
      projectConfig.legacyScripts.filter(
        (fileScript) =>
          !scripts.some(
            (script) =>
              script.command === fileScript.command ||
              script.name.toLowerCase() === fileScript.name.toLowerCase(),
          ),
      ),
    [scripts, projectConfig.legacyScripts],
  );
  const importFileScript = useCallback((fileScript: T3ProjectFileScript) => {
    setRequest(editorRequestForFileScript(fileScript));
  }, []);

  return (
    <SettingsSection id="project-actions" title="Actions">
      <SettingsRow
        serverScoped
        settingKeys={["defaultProjectScripts"]}
        mixed={mixed}
        title="Actions"
        description="Commands that run in this project's checkout or its worktree, with optional shortcuts."
        onResetOverride={() => void persist(() => null)}
        control={
          <div className="flex flex-wrap items-center gap-1.5">
            {importableScripts.length > 0 ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      id="import-scripts"
                      size="xs"
                      variant="ghost"
                      disabled={saving || !canWriteSettings}
                      type="button"
                    />
                  }
                >
                  Import scripts
                  <ChevronDownIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuGroup>
                    <MenuGroupLabel>Import from t3.json</MenuGroupLabel>
                    <p className="px-2 pb-2 text-pretty text-sm text-muted-foreground">
                      Review actions declared by this checkout before importing them.
                    </p>
                  </MenuGroup>
                  <MenuSeparator />
                  {importableScripts.map((fileScript) => (
                    <MenuItem
                      key={`${fileScript.name} ${fileScript.command}`}
                      onClick={() => importFileScript(fileScript)}
                    >
                      <ScriptIcon icon={fileScript.icon ?? "play"} className="size-4 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">
                          {projectScriptMenuLabel(fileScript)}
                        </div>
                        <div className="truncate font-mono text-muted-foreground">
                          {fileScript.command}
                        </div>
                      </div>
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={saving || !canWriteSettings || targets.length === 0}
              onClick={() => setRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })}
            >
              <PlusIcon className="size-3.5" />
              Add action
            </Button>
          </div>
        }
      />
      {mixed ? (
        <SettingsRow
          title="Different actions across environments"
          description="Choose one environment to edit its list. Adding an action here adds it on every selected environment."
        />
      ) : (
        <ProjectActionsList
          scripts={actions}
          keybindings={keybindings}
          disabled={saving || !canWriteSettings}
          onEdit={(script) => setRequest(editorRequestForScript(script, keybindings))}
          {...(representativeMember
            ? {
                onReview: (script: ResolvedProjectAction) =>
                  setReviewing({
                    environmentId: representativeMember.environmentId,
                    projectId: representativeMember.id,
                    actionId: script.id,
                  }),
              }
            : {})}
        />
      )}
      {projectConfig.status === "invalid" ? (
        <SettingsRow
          title={`${projectConfig.source} is invalid`}
          description={`A ${projectConfig.source} exists in this checkout but its JSON is malformed or its root is not an object, so the file cannot be read.`}
          className="text-warning"
        />
      ) : null}
      {projectConfig.status === "partial" ? (
        <SettingsRow
          title={`Some ${projectConfig.source} values were ignored`}
          description="Invalid or unrecognized fields and actions were skipped. Valid project settings and actions remain available."
          className="text-warning"
        />
      ) : null}
      <FileActionApprovalDialog target={reviewing} onClose={() => setReviewing(null)} />
      {target && (
        <ProjectScriptEditorDialog
          environmentId={target.environmentId}
          editScope={AuthSettingsWriteScope}
          request={request}
          scripts={actions}
          onSubmit={(scriptId, input) => submit(scriptId, input, fileActionIds)}
          onDelete={(id) => {
            // Removing an override hands the id, and its shortcut, back to styal.json.
            const restoresFileAction = actions.some(
              (action) => action.id === id && action.source === "override",
            );
            void persist(
              (current) => current.filter((script) => script.id !== id),
              id,
              null,
              restoresFileAction,
            );
          }}
          onClose={() => setRequest(null)}
        />
      )}
    </SettingsSection>
  );
}
