import { useParams } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { resolvePastedPath } from "@t3tools/shared/path";
import {
  type EnvironmentId,
  type ProjectId,
  type ProjectIgnoredFile,
  type ScopedProjectRef,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  type CloneProtocol,
  cloneUrlForProtocol,
  cloneUrlProtocol,
} from "@t3tools/shared/cloneUrl";
import { ArrowRightIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Schema } from "effect";
import { create } from "zustand";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  defaultCloneDestination,
  projectCloneSourceUrl,
  useAddProjectTargets,
} from "../hooks/useAddProjectTargets";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useStableCallback } from "../hooks/useStableCallback";
import { useLogicalProjectEnvironments } from "../hooks/useLogicalProjectEnvironments";
import {
  COPYABLE_FILE_MAX_BYTES,
  type CancelledAddOutcome,
  NoAnswerError,
  addProjectToMachine,
  settleCancelledAdd,
  isDefaultCopiedFile,
  readPreparingAdd,
  setPreparingAdd,
} from "../lib/addProjectToMachine";
import { formatBytes } from "../lib/formatBytes";
import { newProjectId } from "../lib/utils";
import { readProject, subscribeProject, useProject } from "../state/entities";
import { readEnvironment, useEnvironments } from "../state/environments";
import { filesystemEnvironment } from "../state/filesystem";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import {
  answeredSince,
  defaultCopiesState,
  quickAddDecision,
} from "./AddProjectToMachineDialog.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { toastManager } from "./ui/toast";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

interface AddProjectToMachineRequest {
  readonly projectRef: ScopedProjectRef;
  readonly targetEnvironmentId: EnvironmentId | null;
  /** The draft that moves to the new machine; defaults to the draft the route shows. */
  readonly draftId?: DraftId | undefined;
  /** Limits the machines offered, such as to those where a project chat can start. */
  readonly onlyTargets?: ReadonlyArray<EnvironmentId> | undefined;
  /** Start without the dialog when there is nothing to decide; it opens when there is. */
  readonly quick?: boolean;
}

const useRequest = create<{
  request: AddProjectToMachineRequest | null;
  session: number;
  /** When the request was made; one click only trusts checks answered after it. */
  openedAt: number;
  // Kept with the request, not the dialog, which can remount while its clone request is out.
  /** Set while the clone request is out: cancels it, and stops a second start meanwhile. */
  abandon: (() => void) | null;
  error: string | null;
}>(() => ({
  request: null,
  session: 0,
  openedAt: 0,
  abandon: null,
  error: null,
}));

let endRequestWithProject: (() => void) | null = null;
const isNoAnswer = Schema.is(NoAnswerError);

/** How long one click waits on its checks before the dialog opens to show them. */
const QUICK_ADD_WAIT_MS = 3_000;

/** Opens the dialog that clones a project onto another connected machine. */
export function openAddProjectToMachine(request: AddProjectToMachineRequest) {
  if (readProject(request.projectRef) === null) return;
  // One one-click add at a time: nothing replaces it while it is being decided or sent.
  if (readPreparingAdd() !== null) return;
  endRequestWithProject?.();
  // The request ends when its project goes away, so a project that comes back
  // later cannot reopen a dialog nobody asked for.
  endRequestWithProject = subscribeProject(request.projectRef, (project) => {
    if (project === null) close();
  });
  const session = useRequest.getState().session + 1;
  if (request.quick && request.targetEnvironmentId && request.draftId) {
    setPreparingAdd({
      title: addingTitle(readEnvironment(request.targetEnvironmentId)?.label),
      draftId: request.draftId,
      projectRef: request.projectRef,
      onCancel: () => close(session),
    });
  }
  useRequest.setState({ request, session, openedAt: Date.now(), abandon: null, error: null });
}

const addingTitle = (label: string | undefined) => `Adding to ${label ?? "another machine"}`;

/** Says what became of an add cancelled after its clone request was sent, unless it was removed. */
function announceCancelledAdd(outcome: CancelledAddOutcome, projectTitle: string, machine: string) {
  switch (outcome) {
    case "removed":
      return;
    case "completed":
      toastManager.add({
        type: "success",
        title: `Added ${projectTitle} to ${machine}`,
        description: "It finished before the cancel reached it, so it was kept.",
      });
      return;
    case "existing":
      toastManager.add({
        type: "info",
        title: `${projectTitle} stays on ${machine}`,
        description: `${machine} already had this project, so it was not removed.`,
      });
      return;
    case "failed":
      toastManager.add({
        type: "warning",
        title: `Could not finish cancelling on ${machine}`,
        description: `${projectTitle} may still be there. Check it in Settings → Projects.`,
      });
  }
}

/** Ends the request, and its add unless that is being sent; with `session`, only if still open. */
function close(session?: number) {
  if (session !== undefined && useRequest.getState().session !== session) return;
  if (!readPreparingAdd()?.sending) setPreparingAdd(null);
  endRequestWithProject?.();
  endRequestWithProject = null;
  useRequest.setState({ request: null });
}

export function AddProjectToMachineDialogHost() {
  const request = useRequest((state) => state.request);
  const session = useRequest((state) => state.session);
  const openedAt = useRequest((state) => state.openedAt);
  return request ? (
    <AddProjectToMachineDialog
      key={session}
      session={session}
      request={request}
      openedAt={openedAt}
    />
  ) : null;
}

function AddProjectToMachineDialog({
  session,
  request,
  openedAt,
}: {
  session: number;
  request: AddProjectToMachineRequest;
  openedAt: number;
}) {
  const id = useId();
  const project = useProject(request.projectRef);
  const handleNewThread = useNewThreadHandler();
  const { draftId: routeDraftId } = useParams({ strict: false });
  const { environments } = useEnvironments();
  const targets = useAddProjectTargets(
    project,
    useLogicalProjectEnvironments(project, false),
  ).filter((t) => request.onlyTargets?.includes(t.environmentId) ?? true);
  const [targetId, setTargetId] = useState(request.targetEnvironmentId);
  const chosenTarget = targets.find((t) => t.environmentId === targetId) ?? null;
  // Once the dialog has shown, only its Clone button starts the clone.
  const [asked, setAsked] = useState(false);
  // One click goes only to the machine that was clicked; if it drops, the dialog asks instead,
  // offering the machines that remain.
  const target = request.quick && !asked ? chosenTarget : (chosenTarget ?? targets[0] ?? null);
  const source = environments.find((env) => env.environmentId === request.projectRef.environmentId);
  const sourceUrl = projectCloneSourceUrl(project);
  const [protocol, setProtocol] = useState<CloneProtocol | null>(() => cloneUrlProtocol(sourceUrl));
  const sshUrl = cloneUrlForProtocol(sourceUrl, "ssh");
  const httpsUrl = cloneUrlForProtocol(sourceUrl, "https");
  const remoteUrl =
    (protocol === "ssh" ? sshUrl : protocol === "https" ? httpsUrl : null) ?? sourceUrl;

  const targetEnvironment = environments.find((env) => env.environmentId === target?.environmentId);
  const defaultPath = defaultCloneDestination(sourceUrl, targetEnvironment?.serverConfig);
  const [pathOverride, setPathOverride] = useState<string | null>(null);
  const destinationPath = pathOverride ?? defaultPath;
  // Only the default folder is checked; a folder typed in is the user's own choice.
  const defaultFolder = useEnvironmentQuery(
    target
      ? filesystemEnvironment.getMetadata({
          environmentId: target.environmentId,
          input: { paths: [defaultPath] },
        })
      : null,
  );
  const defaultFolderExists = (defaultFolder.data?.entries[0] ?? null) !== null;

  const canListFiles = source?.serverConfig?.environment.capabilities.ignoredFileListing === true;
  const ignoredFiles = useEnvironmentQuery(
    project && canListFiles
      ? projectEnvironment.listIgnoredFiles({
          environmentId: project.environmentId,
          input: { cwd: project.workspaceRoot },
        })
      : null,
  );
  const files = ignoredFiles.data?.files ?? [];
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const selectedFiles = selected ?? defaultSelection(files);
  const copyable = files.filter((file) => file.byteLength <= COPYABLE_FILE_MAX_BYTES);
  const selectedBytes = files
    .filter((file) => selectedFiles.has(file.path))
    .reduce((total, file) => total + file.byteLength, 0);

  const submitting = useRequest((state) => state.abandon !== null);
  const error = useRequest((state) => state.error);
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer: slow checks open the dialog instead of leaving the click unanswered
  useEffect(() => {
    if (!request.quick) return;
    const timer = setTimeout(() => setWaitedTooLong(true), QUICK_ADD_WAIT_MS);
    return () => clearTimeout(timer);
  }, [request.quick]);
  const refreshIgnoredFiles = ignoredFiles.refresh;
  const refreshDefaultFolder = defaultFolder.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one click decides on the files and folder as they are now; a cached answer could skip a question
  useEffect(() => {
    if (!request.quick) return;
    refreshIgnoredFiles();
    refreshDefaultFolder();
  }, [request.quick, refreshIgnoredFiles, refreshDefaultFolder]);
  const quickDecision = request.quick
    ? quickAddDecision({
        targetAvailable: target !== null,
        waitedTooLong,
        defaultCopies: defaultCopiesState({
          canListFiles,
          error: ignoredFiles.error,
          data: ignoredFiles.data,
          answered: answeredSince(ignoredFiles, openedAt),
          defaultCount: defaultSelection(files).size,
        }),
        destination: defaultFolder.error
          ? "failed"
          : answeredSince(defaultFolder, openedAt)
            ? defaultFolderExists
              ? "exists"
              : "missing"
            : "loading",
      })
    : "ask";
  if ((quickDecision === "ask" || error !== null) && !asked) setAsked(true);
  const decision = asked ? "ask" : quickDecision;

  // The project or every target can vanish while the dialog is open. Submitting
  // before the file list loads would silently skip the default .env copies.
  const unavailable =
    project === null ||
    target === null ||
    (canListFiles && ignoredFiles.data === null && ignoredFiles.error === null);
  const toggleFile = (path: string, checked: boolean) => {
    const next = new Set(selectedFiles);
    if (checked) next.add(path);
    else next.delete(path);
    setSelected(next);
  };

  // Lands the user on the new machine right away; its composer shows the clone
  // and holds sends until it finishes. A draft open on the source project moves
  // over with whatever was typed in it.
  const openClonedProject = (targetRef: ScopedProjectRef) => {
    const drafts = useComposerDraftStore.getState();
    const draftId = request.draftId ?? (routeDraftId as DraftId | undefined);
    const draft = draftId ? drafts.getDraftSession(draftId) : null;
    if (
      draftId &&
      draft &&
      !draft.promotedTo &&
      draft.environmentId === request.projectRef.environmentId &&
      draft.projectId === request.projectRef.projectId
    ) {
      drafts.setDraftThreadContext(draftId, {
        projectRef: targetRef,
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
      });
      return;
    }
    void handleNewThread(targetRef);
  };

  // Shared by the Clone button and one click, so one request can never start two clones.
  const startClone = useStableCallback(async () => {
    if (!project || !target || useRequest.getState().abandon) return;
    let abandoned = false;
    // Cancelling while the clone request is out lets go of it; a clone that starts anyway goes.
    const abandon = () => {
      abandoned = true;
      const add = readPreparingAdd();
      setPreparingAdd(add && { ...add, cancelled: true });
      close(session);
    };
    useRequest.setState({ abandon, error: null });
    const preparing = readPreparingAdd();
    if (preparing) {
      setPreparingAdd({
        ...preparing,
        title: addingTitle(target.label),
        sending: true,
        onCancel: abandon,
      });
    }
    // The server may clone for a project it already had instead; only a new one is ours to remove.
    const requestedProjectId = newProjectId();
    let projectId: ProjectId;
    try {
      projectId = await addProjectToMachine({
        source: { environmentId: project.environmentId, cwd: project.workspaceRoot },
        subdirectory: projectSubdirectory(
          project.repositoryIdentity?.rootPath,
          project.workspaceRoot,
        ),
        target: { environmentId: target.environmentId, label: target.label },
        projectId: requestedProjectId,
        title: project.title,
        remoteUrl,
        destinationPath: destinationPath.trim(),
        files: files.filter((file) => selectedFiles.has(file.path)).map((file) => file.path),
      });
    } catch (cause) {
      if (preparing) setPreparingAdd(null);
      if (abandoned && isNoAnswer(cause)) {
        announceCancelledAdd("failed", project.title, target.label);
      }
      if (abandoned || useRequest.getState().session !== session) return;
      const message = cause instanceof Error ? cause.message : "Could not start the clone.";
      useRequest.setState({ abandon: null, error: message });
      return;
    }
    const clonedRef = scopeProjectRef(target.environmentId, projectId);
    if (abandoned) {
      const projectTitle = project.title;
      const machine = target.label;
      void settleCancelledAdd(clonedRef, projectId === requestedProjectId).then((outcome) => {
        if (preparing) setPreparingAdd(null);
        announceCancelledAdd(outcome, projectTitle, machine);
      });
      return;
    }
    if (preparing) setPreparingAdd(null);
    close(session);
    openClonedProject(clonedRef);
  });
  // Closing the dialog while its clone request is out cancels that clone too.
  const dismiss = () => (useRequest.getState().abandon ?? close)();

  const submit = async () => {
    if (!project || !target || submitting) return;
    if (destinationPath.trim().length === 0) {
      useRequest.setState({ error: "Choose a folder on the other machine." });
      return;
    }
    await startClone();
  };

  const startNow = decision === "start" && project !== null && target !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the clone once the checks it waits on have loaded
  useEffect(() => {
    if (startNow) void startClone();
  }, [startNow, startClone]);
  const showDialog = !request.quick || decision === "ask" || error !== null;
  if (!showDialog) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add to another machine</DialogTitle>
            <DialogDescription>
              Clone {project?.repositoryIdentity?.displayName ?? project?.title} and bring the local
              files git does not track.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex items-center gap-4">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex min-w-0 items-center gap-1.5 font-medium text-sm">
                  <EnvironmentMachineIcon
                    kind={resolveEnvironmentMachineKind(source?.serverConfig ?? null)}
                    className="size-3.5 shrink-0"
                  />
                  <span className="truncate">{source?.label ?? "This machine"}</span>
                </span>
                <span className="flex min-w-0 font-mono text-muted-foreground text-xs">
                  <MiddleTruncate value={project?.workspaceRoot ?? ""} />
                </span>
              </div>
              <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="flex min-w-0 max-w-1/2 flex-col items-end gap-1">
                {targets.length > 1 ? (
                  <Select
                    value={target?.environmentId ?? null}
                    onValueChange={(value) => {
                      if (value) setTargetId(value);
                    }}
                    items={targets.map((t) => ({ value: t.environmentId, label: t.label }))}
                  >
                    <SelectTrigger size="sm" aria-label="Machine to add the project to">
                      {target ? (
                        <EnvironmentMachineIcon kind={target.machine} className="size-3.5" />
                      ) : null}
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {targets.map((t) => (
                        <SelectItem key={t.environmentId} value={t.environmentId}>
                          <span className="inline-flex items-center gap-1.5">
                            <EnvironmentMachineIcon kind={t.machine} className="size-3" />
                            {t.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : (
                  <span className="flex min-w-0 items-center gap-1.5 font-medium text-sm">
                    {target ? (
                      <EnvironmentMachineIcon kind={target.machine} className="size-3.5 shrink-0" />
                    ) : null}
                    <span className="truncate">{target?.label ?? "No machine available"}</span>
                  </span>
                )}
                <span className="flex min-w-0 max-w-full font-mono text-muted-foreground text-xs">
                  <MiddleTruncate value={destinationPath} />
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Clone over</Label>
              {sshUrl && httpsUrl ? (
                <ToggleGroup
                  aria-label="Clone protocol"
                  value={protocol ? [protocol] : []}
                  onValueChange={(next) => {
                    const value = next[0];
                    if (value === "ssh" || value === "https") setProtocol(value);
                  }}
                >
                  <Toggle value="ssh">SSH</Toggle>
                  <Toggle value="https">HTTPS</Toggle>
                </ToggleGroup>
              ) : null}
              <span className="truncate font-mono text-muted-foreground text-xs">{remoteUrl}</span>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-path`}>Folder on {target?.label ?? "the other machine"}</Label>
              <Input
                id={`${id}-path`}
                value={destinationPath}
                onChange={(event) =>
                  setPathOverride(resolvePastedPath(destinationPath, event.target.value))
                }
                spellCheck={false}
                autoComplete="off"
              />
              {pathOverride === null && defaultFolderExists ? (
                <p className="flex items-start gap-1.5 text-warning-foreground text-xs">
                  <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
                  <span>
                    This folder already exists on {target?.label ?? "the other machine"}. The clone
                    fails unless it is empty: choose a new folder, or empty this one first.
                  </span>
                </p>
              ) : null}
            </div>

            {!canListFiles && source ? (
              <p className="flex items-start gap-1.5 text-warning-foreground text-xs">
                <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
                <span>
                  {source.label} cannot list the files git ignores, so none will be copied.
                </span>
              </p>
            ) : null}
            {canListFiles ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Label className="flex-1">Copy ignored files</Label>
                  {copyable.length > 0 ? (
                    <>
                      <span className="text-muted-foreground text-xs">
                        {selectedFiles.size} of {files.length}
                        {selectedBytes > 0 ? ` · ${formatBytes(selectedBytes)}` : ""}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          setSelected(
                            selectedFiles.size === copyable.length
                              ? new Set()
                              : new Set(copyable.map((file) => file.path)),
                          )
                        }
                      >
                        {selectedFiles.size === copyable.length ? "None" : "All"}
                      </Button>
                    </>
                  ) : null}
                </div>
                {request.quick && selectedFiles.size > 0 ? (
                  <p className="text-muted-foreground text-xs">
                    The ticked files will be copied to {target?.label ?? "the other machine"}.
                    Untick any it should not have.
                  </p>
                ) : null}
                {ignoredFiles.error ? (
                  <p className="text-destructive-foreground text-xs">{ignoredFiles.error}</p>
                ) : ignoredFiles.data?.failed ? (
                  <p className="flex items-start gap-1.5 text-warning-foreground text-xs">
                    <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
                    <span>
                      Could not list the files git ignores on {source?.label ?? "this machine"}, so
                      none will be copied.
                    </span>
                  </p>
                ) : files.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    {ignoredFiles.isSuccess
                      ? "No ignored files to copy."
                      : "Finding ignored files…"}
                  </p>
                ) : (
                  <div className="max-h-52 overflow-y-auto rounded-md border">
                    {files.map((file) => (
                      <IgnoredFileRow
                        key={file.path}
                        file={file}
                        checked={selectedFiles.has(file.path)}
                        onCheckedChange={(checked) => toggleFile(file.path, checked)}
                      />
                    ))}
                  </div>
                )}
                {ignoredFiles.data?.truncated ? (
                  <p className="text-muted-foreground text-xs">
                    Showing the first {files.length} files.
                  </p>
                ) : null}
                <p className="text-muted-foreground text-xs">
                  Files are copied after the clone finishes. Folders git ignores whole, like
                  node_modules, are left out.
                </p>
              </div>
            ) : null}

            {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={dismiss}>
              Cancel
            </Button>
            <Button type="submit" disabled={unavailable || submitting}>
              {submitting ? "Starting…" : `Clone to ${target?.label ?? "machine"}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * A project can be rooted below its repository's top folder. The clone lands
 * at the top, so copied files keep the same path below it.
 */
function projectSubdirectory(repositoryRoot: string | undefined, workspaceRoot: string) {
  if (!repositoryRoot) return "";
  const prefix = repositoryRoot.replace(/[\\/]+$/, "");
  const rest = workspaceRoot.slice(prefix.length);
  return workspaceRoot.startsWith(prefix) && /^[\\/]/.test(rest)
    ? rest.slice(1).replaceAll("\\", "/")
    : "";
}

function defaultSelection(files: readonly ProjectIgnoredFile[]): ReadonlySet<string> {
  return new Set(
    files
      .filter(
        (file) => file.byteLength <= COPYABLE_FILE_MAX_BYTES && isDefaultCopiedFile(file.path),
      )
      .map((file) => file.path),
  );
}

function IgnoredFileRow({
  file,
  checked,
  onCheckedChange,
}: {
  file: ProjectIgnoredFile;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const tooLarge = file.byteLength > COPYABLE_FILE_MAX_BYTES;
  return (
    <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm not-last:border-b has-disabled:cursor-not-allowed has-disabled:opacity-64">
      <Checkbox checked={checked} disabled={tooLarge} onCheckedChange={onCheckedChange} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
        {tooLarge ? "Over 1 MB" : formatBytes(file.byteLength)}
      </span>
    </label>
  );
}
