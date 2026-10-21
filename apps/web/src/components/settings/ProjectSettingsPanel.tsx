import { useComposerMenuState } from "../chat/useComposerMenuState";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope, readEnvironmentScope } from "../../state/session";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { planProjectRemoval } from "@t3tools/client-runtime/state/projects";
import { AsyncResult } from "effect/reactivity";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ProjectIconOverride,
  resolveEnvironmentMachineKind,
  type SourceControlDefaultRepositoryState,
} from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { ArchiveIcon, ArchiveRestoreIcon, InfoIcon, Trash2Icon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { readLocalApi } from "../../localApi";
import {
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadShells, waitForProjectRemoval } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjectGroupActions } from "../../hooks/useProjectGroupActions";
import { ProjectFavicon } from "../ProjectFavicon";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { EnvironmentRow } from "./EnvironmentRow";
import {
  ForkFeatureBadge,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { ProjectAgentAccessSettings } from "./AgentAccessSettings";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { ProjectSimulatorMemorySettings } from "./SimulatorMemorySetting";
import { projectGroupTitleNeedsUpdate } from "./ProjectSettingsPanel.logic";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";

const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

/** Sentinel for the Select, which cannot carry a null value. */
const UNSET_DEFAULT_REPOSITORY_VALUE = "__unset__";

function defaultRepositoryLabel(
  state: SourceControlDefaultRepositoryState,
  remoteName: string | null,
): string {
  if (remoteName === null) {
    // Unpinned repositories fall back to the GitHub CLI's own guess, which
    // prefers a fork's parent once an upstream remote exists.
    return "Not set (GitHub CLI decides)";
  }
  const remote = state.remotes.find((candidate) => candidate.remoteName === remoteName);
  const label = remote?.nameWithOwner ?? remote?.url ?? remoteName;
  return remote?.nameWithOwner ? `${label} (${remoteName})` : label;
}

/**
 * A pin can name a repository its remote does not point at, which is what the
 * GitHub CLI writes for a fork cloned without an upstream remote. The trigger
 * has to show the repository actually targeted, while the options keep
 * describing the remotes they would switch to.
 */
function currentDefaultRepositoryLabel(state: SourceControlDefaultRepositoryState): string {
  return state.defaultRemoteName && state.defaultRepositoryPath
    ? `${state.defaultRepositoryPath} (via ${state.defaultRemoteName})`
    : defaultRepositoryLabel(state, state.defaultRemoteName);
}

const DEFAULT_REPOSITORY_DESCRIPTION =
  "Which repository pull requests, issues, and releases target in this checkout, shared with the GitHub CLI's gh repo set-default. Changing it can move this checkout to a different project group.";

/**
 * The config `gh repo set-default` writes for one checkout. Returns null
 * until the checkout has a choice to make: the pin only means something to
 * the GitHub CLI, and only a checkout with more than one remote (or an
 * existing pin to clear) can change it.
 */
function useDefaultRepository(checkout: SidebarProjectGroupMember) {
  // Keyed by checkout, so a row never shows another checkout's state while
  // its own read is in flight.
  const [loaded, setLoaded] = useState<{
    environmentId: EnvironmentId;
    workspaceRoot: string;
    state: SourceControlDefaultRepositoryState;
  } | null>(null);
  const readDefaultRepository = useAtomQueryRunner(sourceControlEnvironment.defaultRepository, {
    reportFailure: false,
  });
  const writeDefaultRepository = useAtomCommand(sourceControlEnvironment.setDefaultRepository, {
    reportFailure: false,
  });
  const { environmentId, workspaceRoot } = checkout;
  const checkoutRootRef = useRef(workspaceRoot);
  useEffect(() => {
    let cancelled = false;
    checkoutRootRef.current = workspaceRoot;
    void readDefaultRepository({
      environmentId,
      input: { cwd: workspaceRoot },
    }).then((result) => {
      if (!cancelled && result._tag === "Success") {
        setLoaded({ environmentId, workspaceRoot, state: result.value });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [readDefaultRepository, environmentId, workspaceRoot]);

  const update = async (remoteName: string | null): Promise<void> => {
    const target = checkout;
    const result = await writeDefaultRepository({
      environmentId: target.environmentId,
      input: { cwd: target.workspaceRoot, remoteName },
    });
    // Switching checkouts mid-write must not drop the old checkout's state
    // into the new checkout's row.
    if (result._tag === "Success" && target.workspaceRoot === checkoutRootRef.current) {
      setLoaded({
        environmentId: target.environmentId,
        workspaceRoot: target.workspaceRoot,
        state: result.value,
      });
    }
  };

  const defaultRepository =
    loaded?.environmentId === environmentId && loaded.workspaceRoot === workspaceRoot
      ? loaded.state
      : null;

  if (
    defaultRepository === null ||
    !defaultRepository.remotes.some((remote) => remote.provider === "github") ||
    (defaultRepository.remotes.length <= 1 && defaultRepository.defaultRemoteName === null)
  ) {
    return null;
  }
  return { state: defaultRepository, update };
}

function DefaultRepositorySelect({
  state,
  update,
  size,
  className,
  ariaLabel,
}: {
  state: SourceControlDefaultRepositoryState;
  update: (remoteName: string | null) => Promise<void>;
  size?: "xs";
  /** Layout width for the trigger, set by the row it sits in. */
  className?: string;
  ariaLabel: string;
}) {
  return (
    <Select
      value={state.defaultRemoteName ?? UNSET_DEFAULT_REPOSITORY_VALUE}
      onValueChange={(value) => {
        const remoteName = String(value);
        void update(remoteName === UNSET_DEFAULT_REPOSITORY_VALUE ? null : remoteName);
      }}
    >
      <SelectTrigger
        {...(size ? { size } : {})}
        {...(className ? { className } : {})}
        aria-label={ariaLabel}
      >
        <SelectValue>{currentDefaultRepositoryLabel(state)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {state.remotes.map((remote) => (
          <SelectItem hideIndicator key={remote.remoteName} value={remote.remoteName}>
            {defaultRepositoryLabel(state, remote.remoteName)}
          </SelectItem>
        ))}
        <SelectItem hideIndicator value={UNSET_DEFAULT_REPOSITORY_VALUE}>
          {defaultRepositoryLabel(state, null)}
        </SelectItem>
      </SelectPopup>
    </Select>
  );
}

/** The default repository row for a project with a single checkout. */
function DefaultRepositorySetting({ checkout }: { checkout: SidebarProjectGroupMember }) {
  const defaultRepository = useDefaultRepository(checkout);
  if (defaultRepository === null) return null;
  return (
    <SettingsRow
      title="Default repository"
      forkFeature="source-control-fork-remotes"
      description={DEFAULT_REPOSITORY_DESCRIPTION}
      control={<DefaultRepositorySelect {...defaultRepository} ariaLabel="Default repository" />}
    />
  );
}

/**
 * One checkout of a multi-checkout project: its environment and folder, with
 * the checkout's own settings under it.
 */
function CheckoutRow({
  checkout,
  machineKind,
  canRemove,
  onRemove,
}: {
  checkout: SidebarProjectGroupMember;
  machineKind: EnvironmentMachineKind;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const defaultRepository = useDefaultRepository(checkout);
  const environmentLabel = checkout.environmentLabel ?? "Environment";
  return (
    <EnvironmentRow
      kind={machineKind}
      label={environmentLabel}
      subtitle={checkout.workspaceRoot}
      detail={
        defaultRepository ? (
          <div className="mt-2 flex min-w-0 items-center justify-between gap-3">
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      tabIndex={0}
                      className="rounded-sm underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    />
                  }
                >
                  Default repository
                </TooltipTrigger>
                <TooltipPopup side="top" className="max-w-xs">
                  {DEFAULT_REPOSITORY_DESCRIPTION}
                </TooltipPopup>
              </Tooltip>
              <ForkFeatureBadge />
            </span>
            <DefaultRepositorySelect
              {...defaultRepository}
              size="xs"
              className="w-auto max-w-72 min-w-0"
              ariaLabel={`Default repository for ${environmentLabel}`}
            />
          </div>
        ) : null
      }
    >
      <Button
        size="xs"
        variant="outline"
        disabled={!canRemove}
        onClick={onRemove}
        aria-label={`Remove checkout ${checkout.workspaceRoot}`}
      >
        Remove
      </Button>
    </EnvironmentRow>
  );
}

export type ProjectSettingsCategory = "general" | "source-control" | "project";

export function ProjectSettingsPanel({
  projectKey,
  environmentId = null,
  checkoutKey = null,
  unavailable,
}: {
  projectKey: string;
  environmentId?: EnvironmentId | null;
  checkoutKey?: string | null;
  unavailable?: ReactNode;
}) {
  const groups = useSettingsProjectGroups();
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useLocation({ select: (location) => location.pathname });

  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;
  const members =
    selected?.memberProjects.filter(
      (member) =>
        (environmentId === null || member.environmentId === environmentId) &&
        (checkoutKey === null || member.physicalProjectKey === checkoutKey),
    ) ?? [];

  // Remember the members of the last rendered group so a grouping-rule change
  // (which changes the group key) can follow the project to its new group.
  const lastSelectionRef = useRef<{
    key: string;
    environmentId: EnvironmentId | null;
    checkoutKey: string | null;
    memberKeys: string[];
  } | null>(null);
  useEffect(() => {
    if (!selected || members.length === 0) return;
    lastSelectionRef.current = {
      key: selected.projectKey,
      environmentId,
      checkoutKey,
      memberKeys: members.map((member) => member.physicalProjectKey),
    };
  }, [selected, members, environmentId, checkoutKey]);

  useEffect(() => {
    if (members.length > 0) return;
    const last = lastSelectionRef.current;
    if (
      last?.key !== projectKey ||
      last.environmentId !== environmentId ||
      last.checkoutKey !== checkoutKey
    )
      return;
    const successor = groups.find((group) =>
      group.memberProjects.some((member) => last.memberKeys.includes(member.physicalProjectKey)),
    );
    if (successor) {
      void navigate({
        to: pathname,
        search: () => ({
          project: successor.projectKey,
          machine: environmentId ?? undefined,
          checkout: checkoutKey ?? undefined,
        }),
        replace: true,
        hashScrollIntoView: false,
      });
    }
  }, [groups, navigate, pathname, projectKey, members.length, environmentId, checkoutKey]);

  if ((!selected || members.length === 0) && unavailable != null) return unavailable;

  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {groups.length === 0
          ? "Add a project from the sidebar to configure it here."
          : "This project is no longer available."}
      </div>
    );
  }
  if (members.length === 0)
    return (
      <p className="p-8 text-sm text-muted-foreground">
        This checkout is no longer available in the selected project and environment.
      </p>
    );
  const scopedGroup = {
    ...selected,
    memberProjects: members,
    environmentId: members[0]!.environmentId,
    id: members[0]!.id,
  };
  return (
    <ProjectDetail
      key={`${selected.projectKey}:${environmentId ?? "all"}:${checkoutKey ?? "all"}`}
      group={scopedGroup}
      wholeGroup={selected}
      hasOtherMembers={members.length < selected.memberProjects.length}
    />
  );
}

function ProjectDetail({
  group,
  wholeGroup,
  hasOtherMembers,
}: {
  group: SidebarProjectSnapshot;
  /** Pin and archive always apply to every machine, even when one is picked. */
  wholeGroup: SidebarProjectSnapshot;
  hasOtherMembers: boolean;
}) {
  const navigate = useNavigate({ from: "/settings" });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const editableIds = useEnvironmentsWithScope(group.memberProjects, AuthOrchestrationOperateScope);
  const canEditGroup = group.memberProjects.every((member) =>
    editableIds.has(member.environmentId),
  );
  const representative =
    group.memberProjects.find(
      (member) => environmentById.get(member.environmentId)?.serverConfig != null,
    ) ?? group.memberProjects[0]!;
  const threads = useThreadShells();
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const projectNameEditedRef = useRef(false);

  const faviconPath = representative.faviconPath ?? null;
  const projectIcon = representative.projectIcon ?? null;
  const pickProjectFavicon =
    typeof window !== "undefined" &&
    group.memberProjects.every(
      (member) =>
        member.environmentId === primaryEnvironmentId &&
        canPickExternalProjectFavicon(member.workspaceRoot, navigator.platform),
    )
      ? window.desktopBridge?.pickProjectFavicon
      : undefined;
  const additionalInstructions = representative.additionalInstructions ?? null;

  const reportFailure = (title: string, result: AtomCommandResult<void, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };

  const checkProjectAccess = (
    members: ReadonlyArray<SidebarProjectGroupMember>,
    failureTitle: string,
  ) => {
    const denied = members.find(
      (member) => !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
    );
    if (!denied) return null;
    const result = AsyncResult.failure<void, Error>(
      Cause.fail(
        new Error(
          `This connection cannot change projects in ${denied.environmentLabel ?? "this environment"}.`,
        ),
      ),
    );
    reportFailure(failureTitle, result);
    return result;
  };

  const { updateGroup, canOrganize, isBusy, setPinned, setArchived } = useProjectGroupActions();
  const allGroups = useSettingsProjectGroups();
  const isPinned = wholeGroup.pinnedAt != null;
  const isArchived = wholeGroup.archivedAt != null;

  const renameGroup = async (nextTitle: string, wasEdited: boolean) => {
    const title = nextTitle.trim();
    if (!title) {
      toastManager.add({ type: "warning", title: "Project title cannot be empty" });
      return;
    }
    if (
      !projectGroupTitleNeedsUpdate(
        group.memberProjects.map((member) => member.title),
        title,
        wasEdited,
      )
    ) {
      return;
    }
    await updateGroup(group, { title }, "Failed to rename project");
  };

  const [faviconPickerOpen, setFaviconPickerOpen] = useComposerMenuState(!canEditGroup);
  const [iconPickerOpen, setIconPickerOpen] = useComposerMenuState(!canEditGroup);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setProjectIcon = async (input: {
    faviconPath: string | null;
    projectIcon: ProjectIconOverride | null;
  }) => {
    if (savingFaviconRef.current) return;
    savingFaviconRef.current = true;
    setIsSavingFavicon(true);
    await updateGroup(group, input, "Failed to update project icon");
    savingFaviconRef.current = false;
    setIsSavingFavicon(false);
  };

  const setAdditionalInstructions = (instructions: string | null) =>
    void updateGroup(
      group,
      { additionalInstructions: instructions },
      "Failed to update additional instructions",
    );

  const hasMultipleCheckouts = group.memberProjects.length > 1;

  const removeMembers = async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
    if (checkProjectAccess(members, "Failed to remove project")) return;
    const api = readLocalApi();
    if (!api) return;

    const { projectThreads, isWholeGroup, confirmationMessage } = planProjectRemoval({
      members,
      groupMemberCount: group.memberProjects.length,
      hasOtherMembers,
      displayName: group.displayName,
      threads,
    });
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(confirmationMessage, { variant: "destructive" }),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
    if (checkProjectAccess(members, "Failed to remove project")) return;

    const draftStore = useComposerDraftStore.getState();
    for (const member of members) {
      if (checkProjectAccess([member], "Failed to remove project")) return;
      const memberThreads = projectThreads.filter(
        (thread) => thread.environmentId === member.environmentId && thread.projectId === member.id,
      );
      const result = mapAtomCommandResult(
        await deleteProject({
          environmentId: member.environmentId,
          input: {
            projectId: member.id,
            force: true,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        reportFailure(`Failed to remove "${member.title}"`, result);
        return;
      }
      const projectRef = scopeProjectRef(member.environmentId, member.id);
      await waitForProjectRemoval(projectRef);
      releaseProjectDraftUploads(
        projectRef,
        memberThreads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
      );
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
      if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(projectRef);
    }

    if (isWholeGroup && !hasOtherMembers) {
      void navigate({
        to: "/settings/projects",
        search: ({ machine }) => ({ project: undefined, machine, checkout: undefined }),
        replace: true,
      });
    }
  };

  const checkoutsByEnvironment = new Map<EnvironmentId, SidebarProjectGroupMember[]>();
  for (const member of group.memberProjects) {
    const members = checkoutsByEnvironment.get(member.environmentId);
    if (members) members.push(member);
    else checkoutsByEnvironment.set(member.environmentId, [member]);
  }
  const checkoutChoices = (
    <SettingsSection title="Checkouts">
      {Array.from(checkoutsByEnvironment, ([environmentId, members]) => {
        const checkouts = members.map((member) => (
          <CheckoutRow
            key={member.physicalProjectKey}
            checkout={member}
            machineKind={resolveEnvironmentMachineKind(
              environmentById.get(member.environmentId)?.serverConfig ?? null,
            )}
            canRemove={editableIds.has(member.environmentId)}
            onRemove={() => void removeMembers([member])}
          />
        ));
        if (checkoutsByEnvironment.size === 1) return checkouts;
        const environment = environmentById.get(environmentId);
        const labels = environment
          ? settingsScopeEnvironmentLabels(environment, environments)
          : { primary: members[0]!.environmentLabel ?? "Environment", secondary: environmentId };
        return (
          <SettingsRow key={environmentId} title={labels.primary} description={labels.secondary}>
            <div className="space-y-3 pb-2 pt-1">{checkouts}</div>
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );

  return (
    <>
      <SettingsPageContainer className="gap-6">
        <Alert variant="info">
          <InfoIcon aria-hidden />
          <AlertDescription>
            Can't find a setting? Keep this project picked above and hop to any other settings page.
          </AlertDescription>
        </Alert>
        <SettingsSection id="project-overview" title="Project" hideTitle>
          {!canEditGroup ? (
            <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
              {group.memberProjects.length > 1
                ? "Shared settings require permission to change every checkout in this group."
                : "This connection cannot change this project."}
            </p>
          ) : null}
          <SettingsRow
            title="Name"
            description="The shared name for this project group in the sidebar and thread lists."
            control={
              <Input
                key={`${group.projectKey}:${group.displayName}`}
                size="sm"
                className="w-full sm:w-64"
                aria-label="Project name"
                disabled={!canEditGroup}
                defaultValue={group.displayName}
                onChange={() => {
                  projectNameEditedRef.current = true;
                }}
                onBlur={(event) => {
                  const wasEdited = projectNameEditedRef.current;
                  projectNameEditedRef.current = false;
                  void renameGroup(event.currentTarget.value, wasEdited);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          <SettingsRow
            title="Project icon"
            description={
              projectIcon?.kind === "lucide"
                ? `${projectIcon.name} · ${projectIcon.color}`
                : projectIcon?.kind === "monogram"
                  ? `${projectIcon.text} · ${projectIcon.color}`
                  : projectIcon?.kind === "emoji"
                    ? projectIcon.emoji
                    : (faviconPath ?? "Automatic")
            }
            resetAction={
              group.memberProjects.some(
                (member) => member.faviconPath != null || member.projectIcon != null,
              ) ? (
                <SettingResetButton
                  label="project icon"
                  disabled={isSavingFavicon || !canEditGroup}
                  onClick={() => void setProjectIcon({ faviconPath: null, projectIcon: null })}
                />
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <ProjectFavicon project={representative} className="size-6" />
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a project icon"
                  disabled={isSavingFavicon || !canEditGroup}
                  onClick={() => setIconPickerOpen(true)}
                >
                  Choose icon
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a project icon file"
                  disabled={isSavingFavicon || !canEditGroup}
                  onClick={() => setFaviconPickerOpen(true)}
                >
                  Choose file
                </Button>
              </div>
            }
          />
          <SettingsRow
            title="Additional instructions"
            forkFeature="project-agent-instructions"
            description="Included when a new agent session starts for this project; applies to every checkout in this group."
            resetAction={
              additionalInstructions !== null ? (
                <SettingResetButton
                  label="additional instructions"
                  onClick={() => setAdditionalInstructions(null)}
                />
              ) : null
            }
            control={
              <Textarea
                key={`${group.projectKey}:${representative.updatedAt}:additional-instructions`}
                className="min-h-24 w-full sm:w-96"
                aria-label="Additional instructions"
                placeholder="For example: Run focused tests after making changes."
                defaultValue={additionalInstructions ?? ""}
                maxLength={32_000}
                onBlur={(event) => {
                  const nextValue = event.currentTarget.value.trim();
                  const normalized = nextValue.length > 0 ? nextValue : null;
                  if (normalized === additionalInstructions) return;
                  event.currentTarget.value = nextValue;
                  setAdditionalInstructions(normalized);
                }}
              />
            }
          />
          {hasMultipleCheckouts ? null : (
            <DefaultRepositorySetting checkout={group.memberProjects[0]!} />
          )}
          {canOrganize(wholeGroup) ? (
            <>
              <SettingsRow
                title="Pin"
                description="Pinned projects come first in every project picker."
                control={
                  <Switch
                    aria-label="Pin project"
                    checked={isPinned}
                    disabled={isBusy(wholeGroup.projectKey)}
                    onCheckedChange={(checked) =>
                      void setPinned(wholeGroup, Boolean(checked), allGroups)
                    }
                  />
                }
              />
              <SettingsRow
                title="Archive"
                description={
                  isArchived
                    ? "Archived. The project and its threads are hidden until you unarchive it."
                    : "Hides the project and its threads. Nothing is deleted."
                }
                control={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isBusy(wholeGroup.projectKey)}
                    onClick={() => void setArchived(wholeGroup, !isArchived)}
                  >
                    {isArchived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                    {isArchived ? "Unarchive" : "Archive"}
                  </Button>
                }
              />
            </>
          ) : null}
        </SettingsSection>
        <ProjectDefaultsSettings category="project" />
        <ProjectAgentAccessSettings />
        <ProjectSimulatorMemorySettings />
        <ProjectActionsSettings />
        {hasMultipleCheckouts ? checkoutChoices : null}
        <SettingsSection title="Danger">
          <SettingsRow
            title={
              hasOtherMembers
                ? "Remove checkout"
                : group.memberProjects.length > 1
                  ? "Remove this project everywhere"
                  : "Remove project"
            }
            description={
              hasOtherMembers
                ? "Deletes the selected machine's checkout entries and their threads. Other machines and files on disk are not touched."
                : group.memberProjects.length > 1
                  ? `Deletes all ${group.memberProjects.length} checkout entries and their threads on every machine. Files on disk are not touched.`
                  : "Deletes the project entry and its threads. Files on disk are not touched."
            }
            control={
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={!canEditGroup}
                onClick={() => void removeMembers(group.memberProjects)}
              >
                <Trash2Icon />
                {hasOtherMembers
                  ? "Remove checkout"
                  : group.memberProjects.length > 1
                    ? "Remove all entries"
                    : "Remove project"}
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>

      <ProjectFaviconPickerDialog
        key={`${representative.environmentId}:${representative.workspaceRoot}:${faviconPickerOpen}`}
        cwd={representative.workspaceRoot}
        environmentId={representative.environmentId}
        onOpenChange={setFaviconPickerOpen}
        {...(pickProjectFavicon
          ? { onPickExternal: () => pickProjectFavicon(representative.workspaceRoot) }
          : {})}
        onSelect={(path) => void setProjectIcon({ faviconPath: path, projectIcon: null })}
        open={faviconPickerOpen && canEditGroup}
        projectName={group.displayName}
      />
      {iconPickerOpen && canEditGroup ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={projectIcon}
            projectName={representative.title}
            open
            onOpenChange={setIconPickerOpen}
            onSelect={(icon) => void setProjectIcon({ faviconPath: null, projectIcon: icon })}
          />
        </Suspense>
      ) : null}
    </>
  );
}
