import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectScript,
  type ProjectScriptIcon,
  type ResolvedKeybindingsConfig,
  T3ProjectFileScript,
} from "@t3tools/contracts";
import type { ProjectActionSource } from "@t3tools/shared/projectScripts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  BugIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  MonitorIcon,
  PlayIcon,
  RocketIcon,
  WrenchIcon,
} from "lucide-react";
import React, {
  type FormEvent,
  type KeyboardEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  keybindingValueForCommand,
  decodeProjectScriptKeybindingRule,
} from "~/lib/projectScriptKeybindings";
import { keybindingFromKeyboardEvent } from "~/components/settings/KeybindingsSettings.logic";
import { commandForProjectScript, nextProjectScriptId } from "~/projectScripts";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useComposerMenuState } from "./chat/useComposerMenuState";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
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
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";

const SCRIPT_ICONS: Array<{ id: ProjectScriptIcon; label: string }> = [
  { id: "play", label: "Play" },
  { id: "test", label: "Test" },
  { id: "lint", label: "Lint" },
  { id: "configure", label: "Configure" },
  { id: "build", label: "Build" },
  { id: "debug", label: "Debug" },
  { id: "desktop", label: "Desktop" },
  { id: "database", label: "Database" },
  { id: "deploy", label: "Deploy" },
];

export function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  icon: ProjectScriptIcon;
  className?: string;
}) {
  if (icon === "test") return <FlaskConicalIcon className={className} />;
  if (icon === "lint") return <ListChecksIcon className={className} />;
  if (icon === "configure") return <WrenchIcon className={className} />;
  if (icon === "build") return <HammerIcon className={className} />;
  if (icon === "debug") return <BugIcon className={className} />;
  if (icon === "desktop") return <MonitorIcon className={className} />;
  if (icon === "database") return <DatabaseIcon className={className} />;
  if (icon === "deploy") return <RocketIcon className={className} />;
  return <PlayIcon className={className} />;
}

export interface NewProjectScriptInput {
  name: string;
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
  waitForSetup: boolean;
  runOnSettle: boolean;
  /** Omit to preserve the current shortcut when the form did not edit it. */
  keybinding?: string | null;
}

export type ProjectScriptActionResult = AtomCommandResult<void, unknown>;

export const EMPTY_PROJECT_SCRIPT_INPUT: NewProjectScriptInput = {
  name: "",
  command: "",
  icon: "play",
  runOnWorktreeCreate: false,
  waitForSetup: false,
  runOnSettle: false,
  keybinding: null,
};

/**
 * What the editor dialog should open with. `scriptId: null` means "add".
 * `source` says where an edited action comes from: saving a `file` action
 * stores a local override, and deleting an `override` restores the file's.
 */
export interface ProjectScriptEditorRequest {
  scriptId: string | null;
  initial: NewProjectScriptInput;
  source?: ProjectActionSource;
}

export function editorRequestForFileScript(
  fileScript: T3ProjectFileScript,
): ProjectScriptEditorRequest {
  return {
    scriptId: null,
    initial: {
      name: fileScript.name,
      command: fileScript.command,
      icon: fileScript.icon ?? "play",
      runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
      waitForSetup: fileScript.runOnWorktreeCreate === true && fileScript.async === false,
      runOnSettle: fileScript.runOnSettle ?? false,
      keybinding: null,
    },
  };
}

export function editorRequestForScript(
  script: ProjectScript & { readonly source?: ProjectActionSource },
  keybindings: ResolvedKeybindingsConfig,
): ProjectScriptEditorRequest {
  return {
    scriptId: script.id,
    ...(script.source === undefined ? {} : { source: script.source }),
    initial: {
      name: script.name,
      command: script.command,
      icon: script.icon,
      runOnWorktreeCreate: script.runOnWorktreeCreate,
      waitForSetup: script.runOnWorktreeCreate && script.async === false,
      runOnSettle: script.runOnSettle ?? false,
      keybinding: keybindingValueForCommand(keybindings, commandForProjectScript(script.id)),
    },
  };
}

export function ProjectScriptEditorDialog({
  environmentId,
  editScope = AuthOrchestrationOperateScope,
  request,
  scripts,
  onSubmit,
  onDelete,
  onClose,
}: {
  environmentId: EnvironmentId;
  editScope?: typeof AuthOrchestrationOperateScope | typeof AuthSettingsWriteScope;
  request: ProjectScriptEditorRequest | null;
  scripts: ReadonlyArray<ProjectScript>;
  onSubmit: (
    scriptId: string | null,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDelete: (scriptId: string) => void;
  onClose: () => void;
}) {
  const canEditActions = useEnvironmentScope(environmentId, editScope);
  // Scope errors by request so late saves cannot overwrite a newer request's error.
  const [errorState, setErrorState] = useState<{
    readonly request: ProjectScriptEditorRequest;
    readonly message: string | null;
  } | null>(null);
  const validationError =
    request === null ? null : errorState?.request === request ? errorState.message : null;
  const setValidationError = (message: string | null) => {
    if (request !== null) setErrorState({ request, message });
  };
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useComposerMenuState(!canEditActions);
  const [deleteName, setDeleteName] = useState("");
  const [lastRequest, setLastRequest] = useState<ProjectScriptEditorRequest | null>(null);
  if (request !== null && request !== lastRequest) setLastRequest(request);
  // Keep the outgoing copy stable while DialogPopup plays its close animation.
  const displayedRequest = request ?? lastRequest;
  const source = displayedRequest?.source ?? "local";

  return (
    <>
      <Dialog
        open={request !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        {/* The form owns its fields so a keystroke re-renders it, not the dialog chrome. */}
        <DialogPopup>
          <ProjectScriptEditorForm
            environmentId={environmentId}
            editScope={editScope}
            request={request}
            displayedRequest={displayedRequest}
            scripts={scripts}
            validationError={validationError}
            onValidationError={setValidationError}
            onSubmit={onSubmit}
            onRequestDelete={(name) => {
              setDeleteName(name);
              setDeleteConfirmOpen(true);
            }}
            onClose={onClose}
          />
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen && canEditActions} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {source === "override"
                ? `Use the styal.json version of "${deleteName}"?`
                : `Delete action "${deleteName}"?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {source === "override"
                ? "Your saved version is removed and the action from the project's styal.json runs instead."
                : "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={!canEditActions}
              onClick={() => {
                if (!request?.scriptId) return;
                if (!readEnvironmentScope(environmentId, editScope)) {
                  setValidationError("This connection cannot change project actions.");
                  return;
                }
                setDeleteConfirmOpen(false);
                onClose();
                onDelete(request.scriptId);
              }}
            >
              {source === "override" ? "Use styal.json version" : "Delete action"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function ProjectScriptEditorForm({
  environmentId,
  editScope,
  request,
  displayedRequest,
  scripts,
  validationError,
  onValidationError: setValidationError,
  onSubmit,
  onRequestDelete,
  onClose,
}: {
  environmentId: EnvironmentId;
  editScope: typeof AuthOrchestrationOperateScope | typeof AuthSettingsWriteScope;
  request: ProjectScriptEditorRequest | null;
  displayedRequest: ProjectScriptEditorRequest | null;
  scripts: ReadonlyArray<ProjectScript>;
  validationError: string | null;
  onValidationError: (error: string | null) => void;
  onSubmit: (
    scriptId: string | null,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onRequestDelete: (name: string) => void;
  onClose: () => void;
}) {
  const canEditActions = useEnvironmentScope(environmentId, editScope);
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const formId = React.useId();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [icon, setIcon] = useState<ProjectScriptIcon>("play");
  const [iconPickerOpen, setIconPickerOpen] = useComposerMenuState(!canEditActions);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [waitForSetup, setWaitForSetup] = useState(false);
  const [runOnSettle, setRunOnSettle] = useState(false);
  const [keybinding, setKeybinding] = useState("");
  const [savingRequest, setSavingRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const pendingSubmissionRef = useRef<{ request: ProjectScriptEditorRequest } | null>(null);

  const isEditing = displayedRequest?.scriptId != null;
  const source = displayedRequest?.source ?? "local";
  const isSaving = request !== null && savingRequest === request;
  const replacedSetupScript = runOnWorktreeCreate
    ? scripts.find(
        (script) => script.runOnWorktreeCreate && script.id !== displayedRequest?.scriptId,
      )
    : null;
  const isEnablingSetup =
    runOnWorktreeCreate && (!isEditing || !displayedRequest?.initial.runOnWorktreeCreate);
  const replacedSettleScript = runOnSettle
    ? scripts.find(
        (script) => script.runOnSettle === true && script.id !== displayedRequest?.scriptId,
      )
    : null;
  const isEnablingSettle = runOnSettle && (!isEditing || !displayedRequest?.initial.runOnSettle);

  useLayoutEffect(
    () => () => {
      if (pendingSubmissionRef.current?.request === request) {
        pendingSubmissionRef.current = null;
      }
    },
    [request],
  );

  const [formRequest, setFormRequest] = useState<ProjectScriptEditorRequest | null>(null);
  if (request !== formRequest) {
    setFormRequest(request);
    if (request) {
      setName(request.initial.name);
      setCommand(request.initial.command);
      setIcon(request.initial.icon);
      setIconPickerOpen(false);
      setRunOnWorktreeCreate(request.initial.runOnWorktreeCreate);
      setWaitForSetup(request.initial.waitForSetup);
      setRunOnSettle(request.initial.runOnSettle);
      setKeybinding(request.initial.keybinding ?? "");
      setSavingRequest(null);
    }
  }

  const close = () => {
    pendingSubmissionRef.current = null;
    setSavingRequest(null);
    setIconPickerOpen(false);
    onClose();
  };

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!readEnvironmentScope(environmentId, editScope)) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      setKeybinding("");
      return;
    }
    const next = keybindingFromKeyboardEvent(event, navigator.platform);
    if (!next) return;
    setKeybinding(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request || pendingSubmissionRef.current !== null) return;
    if (!readEnvironmentScope(environmentId, editScope)) {
      setValidationError("This connection cannot change project actions.");
      return;
    }
    const changesKeybinding =
      (keybinding.trim() || null) !== (request.initial.keybinding?.trim() || null);
    const canChangeKeybinding = readEnvironmentScope(environmentId, AuthSettingsWriteScope);
    if (changesKeybinding && !canChangeKeybinding) {
      setValidationError("This connection cannot change keyboard shortcuts.");
      return;
    }
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) {
      setValidationError("Name is required.");
      return;
    }
    if (trimmedCommand.length === 0) {
      setValidationError("Command is required.");
      return;
    }

    setValidationError(null);
    let payload: NewProjectScriptInput;
    try {
      const scriptIdForValidation =
        request.scriptId ??
        nextProjectScriptId(
          trimmedName,
          scripts.map((script) => script.id),
        );
      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding,
        command: commandForProjectScript(scriptIdForValidation),
      });
      payload = {
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        waitForSetup: runOnWorktreeCreate && waitForSetup,
        runOnSettle,
        ...((request.scriptId === null && canChangeKeybinding) || changesKeybinding
          ? { keybinding: keybindingRule?.key ?? null }
          : {}),
      } satisfies NewProjectScriptInput;
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Failed to save action.");
      return;
    }

    const submission = { request };
    pendingSubmissionRef.current = submission;
    setSavingRequest(request);
    setIconPickerOpen(false);
    try {
      const result = await onSubmit(request.scriptId, payload);
      if (pendingSubmissionRef.current === submission) {
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            setValidationError(error instanceof Error ? error.message : "Failed to save action.");
          }
        } else {
          close();
        }
      }
    } catch (error) {
      if (pendingSubmissionRef.current === submission) {
        setValidationError(error instanceof Error ? error.message : "Failed to save action.");
      }
    }
    if (pendingSubmissionRef.current === submission) {
      pendingSubmissionRef.current = null;
      setSavingRequest(null);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEditing ? "Edit Action" : "Add Action"}</DialogTitle>
        <DialogDescription>
          {source === "file"
            ? "This action comes from the project's styal.json. Saving keeps your version in styal and uses it instead of the file's."
            : source === "override"
              ? "Your saved version replaces this action from the project's styal.json."
              : "Actions are project-scoped commands you can run from the top bar or keybindings."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form id={formId} onSubmit={submit}>
          <fieldset className="space-y-4" disabled={isSaving || !canEditActions}>
            <div className="space-y-1.5">
              <Label htmlFor="script-name">Name</Label>
              <div className="flex items-center gap-2">
                <Popover onOpenChange={setIconPickerOpen} open={iconPickerOpen}>
                  <PopoverTrigger
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        className="size-9 shrink-0"
                        aria-label="Choose icon"
                      />
                    }
                  >
                    <ScriptIcon icon={icon} className="size-4.5" />
                  </PopoverTrigger>
                  <PopoverPopup align="start">
                    <div className="grid grid-cols-3 gap-2">
                      {SCRIPT_ICONS.map((entry) => {
                        const isSelected = entry.id === icon;
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            className={`relative flex flex-col items-center gap-2 rounded-md border px-2 py-2 text-xs dark:border-transparent ${
                              isSelected
                                ? "border-primary/70 bg-primary/10 ring-inset dark:ring-1 dark:ring-primary/30"
                                : "border-border/70 hover:bg-accent/60 dark:bg-white/[0.035]"
                            }`}
                            onClick={() => {
                              setIcon(entry.id);
                              setIconPickerOpen(false);
                            }}
                          >
                            <ScriptIcon icon={entry.id} className="size-4" />
                            <span>{entry.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </PopoverPopup>
                </Popover>
                <Input
                  id="script-name"
                  autoFocus
                  placeholder="Test"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="script-keybinding">Keybinding</Label>
              <Input
                disabled={!canWriteSettings}
                id="script-keybinding"
                placeholder="Press shortcut"
                value={keybinding}
                readOnly
                onKeyDown={captureKeybinding}
              />
              <p className="text-xs text-muted-foreground">
                Press a shortcut. Use <code>Backspace</code> to clear. Shortcuts are
                environment-wide. Projects using the same action share its shortcut.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="script-command">Command</Label>
              <Textarea
                id="script-command"
                placeholder="bun test"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
              />
            </div>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
              <span>
                Run automatically on worktree creation
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  This action runs only in worktrees, not in the project's local checkout.
                </span>
              </span>
              <Switch
                checked={runOnWorktreeCreate}
                onCheckedChange={(checked) => setRunOnWorktreeCreate(Boolean(checked))}
              />
            </label>
            <label
              className={`flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035] ${
                runOnWorktreeCreate ? "" : "opacity-60"
              }`}
            >
              <span>Wait for it to finish before the agent starts</span>
              <Switch
                checked={waitForSetup}
                disabled={!runOnWorktreeCreate}
                onCheckedChange={(checked) => setWaitForSetup(Boolean(checked))}
              />
            </label>
            {isEnablingSetup && (
              <p className="text-sm text-muted-foreground">
                {replacedSetupScript
                  ? `Saving will replace “${replacedSetupScript.name}” as the action that runs automatically in new worktrees.`
                  : "Saving will run this action automatically in new worktrees."}
              </p>
            )}
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
              <span>Run in the thread's worktree when the thread settles</span>
              <Switch
                checked={runOnSettle}
                onCheckedChange={(checked) => setRunOnSettle(Boolean(checked))}
              />
            </label>
            {isEnablingSettle && (
              <p className="text-sm text-muted-foreground">
                {replacedSettleScript
                  ? `Saving will replace “${replacedSettleScript.name}” as the action that runs when a thread settles.`
                  : "Saving will run this action in a thread's worktree each time the thread settles."}
              </p>
            )}
            {validationError && <p className="text-sm text-destructive">{validationError}</p>}
          </fieldset>
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        {isEditing && source !== "file" && (
          <Button
            type="button"
            variant="destructive-outline"
            className="mr-auto"
            disabled={isSaving || !canEditActions}
            onClick={() => onRequestDelete(name)}
          >
            {source === "override" ? "Use styal.json version" : "Delete"}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button form={formId} type="submit" disabled={isSaving || !canEditActions}>
          {isSaving
            ? "Saving…"
            : isEnablingSetup
              ? replacedSetupScript
                ? "Save and replace setup action"
                : "Save and run in new worktrees"
              : source === "file"
                ? "Save my version"
                : isEditing
                  ? "Save changes"
                  : "Save action"}
        </Button>
      </DialogFooter>
    </>
  );
}
