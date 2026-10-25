import { useScopedSettingsWriteAllowed } from "./useScopedSettings";
import {
  AuthSettingsWriteScope,
  resolveEnvironmentMachineKind,
  type ResolvedKeybindingsConfig,
  type ServerSettings,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { projectFileApprovalKey } from "@t3tools/shared/projectFileApprovals";
import {
  mergeProjectActions,
  projectScriptMenuLabel,
  type ResolvedProjectAction,
} from "@t3tools/shared/projectScripts";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { projectConfigRoot, useProjectConfigState } from "../../hooks/useProjectConfig";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
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
import { EnvironmentRow } from "./EnvironmentRow";
import { SettingsGroup } from "./SettingsGroup";
import { ProjectActionsList } from "./ProjectActionsList";
import { ProjectFileMigrationRow } from "./ProjectFileMigrationRow";
import { useProjectScriptSettings } from "./useProjectScriptSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const ACTIONS_DESCRIPTION =
  "Commands that run in this project's checkout or its worktree, with optional shortcuts.";

/** One selected checkout of the project and what its actions resolve against. */
interface ActionsCheckout {
  readonly member: SidebarProjectGroupMember;
  readonly environment: EnvironmentPresentation;
  /** The checkout's saved actions, before styal.json actions are added. */
  readonly saved: ServerSettings["defaultProjectScripts"];
  readonly keybindings: ResolvedKeybindingsConfig;
  /** Where edits are written; null when the environment cannot store project actions. */
  readonly writeTarget: Parameters<typeof useProjectScriptSettings>[0][number] | null;
}

/**
 * Each checkout lists the actions it offers, and edits in a group change only that checkout;
 * adding from the section header adds to every checkout. Shortcuts are environment-wide.
 */
export function ProjectActionsSettings() {
  const { scope, targets, projectFiles } = useSettingsScope();
  const { environments } = useEnvironments();
  const canWriteSettings = useScopedSettingsWriteAllowed();

  const memberById = new Map(scope.members.map((member) => [member.id, member]));
  const checkouts = targets.flatMap((target): ActionsCheckout[] => {
    const member = target.projectId ? memberById.get(target.projectId) : undefined;
    const environment = environments.find((entry) => entry.environmentId === target.environmentId);
    const serverConfig = environment?.serverConfig;
    if (!member || !environment || !serverConfig) return [];
    return [
      {
        member,
        environment,
        saved: target.settings.defaultProjectScripts,
        keybindings: serverConfig.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS,
        // Older servers ignore override records; exclude them from edits and retain their legacy
        // per-project map.
        writeTarget:
          serverConfig.environment?.capabilities.projectSettingsOverrides === true
            ? {
                environmentId: target.environmentId,
                // Writes read the raw environment settings so an override
                // entry is extended, not derived from already-resolved values.
                settings: serverConfig.settings,
                keybindings: serverConfig.keybindings,
                project: member,
              }
            : null,
      },
    ];
  });

  const mixed = checkouts.some(
    (checkout) => JSON.stringify(checkout.saved) !== JSON.stringify(checkouts[0]?.saved),
  );
  const writeTargets = checkouts.flatMap((checkout) =>
    checkout.writeTarget ? [checkout.writeTarget] : [],
  );
  const { saving, persist, submit } = useProjectScriptSettings(writeTargets);
  const [request, setRequest] = useState<ProjectScriptEditorRequest | null>(null);

  if (checkouts.length <= 1) {
    const checkout = checkouts[0];
    return (
      <SettingsSection id="project-actions" title="Actions">
        {checkout ? (
          <CheckoutActions
            checkout={checkout}
            canWriteSettings={canWriteSettings}
            renderHeader={(controls) => (
              <SettingsRow
                serverScoped
                settingKeys={["defaultProjectScripts"]}
                title="Actions"
                description={ACTIONS_DESCRIPTION}
                onResetOverride={() => void persist(() => null)}
                control={controls}
              />
            )}
          />
        ) : (
          <SettingsRow title="Actions" description={ACTIONS_DESCRIPTION} />
        )}
      </SettingsSection>
    );
  }

  // Adding to every checkout picks an id that is free in each of them,
  // including their styal.json actions, so it never overrides a file action.
  const allActions = checkouts.flatMap((checkout) => checkout.saved);
  const fileActionIds = checkouts.flatMap(
    (checkout) =>
      projectFiles.get(checkout.member.physicalProjectKey)?.actions.map((action) => action.id) ??
      [],
  );
  const representative = writeTargets[0];

  // Each checkout is its own card so its actions read as belonging to it.
  return (
    <SettingsSection id="project-actions" title="Actions" variant="plain">
      <div className="space-y-3">
        <SettingsGroup>
          <SettingsRow
            serverScoped
            settingKeys={["defaultProjectScripts"]}
            mixed={mixed}
            title="Actions"
            description={`${ACTIONS_DESCRIPTION} Each checkout below lists the actions it offers; adding here adds the action to all of them.`}
            onResetOverride={() => void persist(() => null)}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={saving || !canWriteSettings || writeTargets.length === 0}
                onClick={() => setRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })}
              >
                <PlusIcon className="size-3.5" />
                Add to all
              </Button>
            }
          />
        </SettingsGroup>
        {checkouts.map((checkout) => (
          <SettingsGroup key={checkout.member.physicalProjectKey}>
            <CheckoutActions
              checkout={checkout}
              canWriteSettings={canWriteSettings}
              renderHeader={(controls) => (
                <EnvironmentRow
                  className="rounded-t-xl bg-muted/30"
                  kind={resolveEnvironmentMachineKind(checkout.environment.serverConfig ?? null)}
                  label={checkout.environment.label}
                  subtitle={checkout.member.workspaceRoot}
                >
                  {controls}
                </EnvironmentRow>
              )}
            />
          </SettingsGroup>
        ))}
      </div>
      {representative ? (
        <ProjectScriptEditorDialog
          environmentId={representative.environmentId}
          editScope={AuthSettingsWriteScope}
          request={request}
          scripts={allActions}
          onSubmit={(scriptId, input) => submit(scriptId, input, fileActionIds)}
          onDelete={() => undefined}
          onClose={() => setRequest(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

/**
 * One checkout's actions: its saved actions followed by the styal.json
 * actions read from its project root, with edits written to it alone.
 */
function CheckoutActions({
  checkout,
  canWriteSettings,
  renderHeader,
}: {
  checkout: ActionsCheckout;
  canWriteSettings: boolean;
  renderHeader: (controls: ReactNode) => ReactNode;
}) {
  const { member, environment, saved, keybindings, writeTarget } = checkout;
  const writeTargets = writeTarget ? [writeTarget] : [];
  const { saving, persist, submit } = useProjectScriptSettings(writeTargets);
  const [request, setRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const [reviewing, setReviewing] = useState<FileActionApprovalTarget | null>(null);
  const projectRoot = projectConfigRoot(member);
  const projectConfig = useProjectConfigState(member.environmentId, projectRoot);
  const approvals =
    environment.serverConfig?.settings.projectFileActionApprovals[projectFileApprovalKey(member)];
  const actions = mergeProjectActions(saved, projectConfig.config, approvals ?? {});
  const fileActionIds = actions
    .filter((action) => action.source !== "local")
    .map((action) => action.id);
  const importableScripts = projectConfig.legacyScripts.filter(
    (fileScript) =>
      !saved.some(
        (script) =>
          script.command === fileScript.command ||
          script.name.toLowerCase() === fileScript.name.toLowerCase(),
      ),
  );
  const importFileScript = (fileScript: T3ProjectFileScript) => {
    setRequest(editorRequestForFileScript(fileScript));
  };
  const disabled = saving || !canWriteSettings || writeTarget === null;

  return (
    <>
      {renderHeader(
        <div className="flex flex-wrap items-center gap-1.5">
          {importableScripts.length > 0 ? (
            <Menu>
              <MenuTrigger
                render={<Button size="xs" variant="ghost" disabled={disabled} type="button" />}
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
            disabled={disabled}
            onClick={() => setRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })}
          >
            <PlusIcon className="size-3.5" />
            Add action
          </Button>
        </div>,
      )}
      <ProjectActionsList
        scripts={actions}
        keybindings={keybindings}
        disabled={disabled}
        onEdit={(script) => setRequest(editorRequestForScript(script, keybindings))}
        onReview={(script: ResolvedProjectAction) =>
          setReviewing({
            environmentId: member.environmentId,
            projectId: member.id,
            actionId: script.id,
          })
        }
      />
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
      {projectConfig.legacyContents !== null ? (
        <ProjectFileMigrationRow
          environmentId={member.environmentId}
          projectRoot={projectRoot}
          environmentLabel={environment.label}
          legacyContents={projectConfig.legacyContents}
        />
      ) : null}
      <FileActionApprovalDialog target={reviewing} onClose={() => setReviewing(null)} />
      <ProjectScriptEditorDialog
        environmentId={member.environmentId}
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
    </>
  );
}
