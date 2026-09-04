import type { ProjectScript, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, DownloadIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { commandForProjectScript, primaryProjectScript } from "~/projectScripts";
import { shortcutLabelForCommand } from "~/keybindings";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  ScriptIcon,
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
  type ProjectScriptEditorRequest,
} from "./projectScriptEditor";
import { Button } from "./ui/button";
import { Group, GroupSeparator } from "./ui/group";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { stackedThreadToast, toastManager } from "./ui/toast";

export type { NewProjectScriptInput, ProjectScriptActionResult };

const NO_LEGACY_SCRIPTS: ReadonlyArray<ProjectScript> = [];

export function openAddProjectScriptEditor(input: {
  refreshFileScripts?: () => void;
  openEditor: () => void;
}) {
  input.refreshFileScripts?.();
  input.openEditor();
}

interface ProjectScriptsControlProps {
  /** Live scripts declared in the active checkout's styal.json. */
  scripts: ReadonlyArray<ProjectScript>;
  /** Database and t3.json actions that can be copied into this checkout. */
  legacyScripts?: ReadonlyArray<ProjectScript>;
  hasLegacyConfig?: boolean;
  keybindings: ResolvedKeybindingsConfig;
  preferredScriptId?: string | null;
  onRefreshFileScripts?: () => void;
  onMigrateLegacyScripts: () => Promise<ProjectScriptActionResult>;
  onRunScript: (script: ProjectScript) => void;
  onAddScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export default function ProjectScriptsControl({
  scripts,
  legacyScripts = NO_LEGACY_SCRIPTS,
  hasLegacyConfig = legacyScripts.length > 0,
  keybindings,
  preferredScriptId = null,
  onRefreshFileScripts,
  onMigrateLegacyScripts,
  onRunScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
}: ProjectScriptsControlProps) {
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [editorRequest, setEditorRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const editorScripts = useMemo(() => [...scripts, ...legacyScripts], [legacyScripts, scripts]);

  const primaryScript = useMemo(() => {
    if (preferredScriptId) {
      const preferred = scripts.find((script) => script.id === preferredScriptId);
      if (preferred) return preferred;
    }
    return primaryProjectScript(scripts);
  }, [preferredScriptId, scripts]);
  const dropdownItemClassName =
    "data-highlighted:bg-transparent data-highlighted:text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground data-highlighted:hover:bg-accent data-highlighted:hover:text-accent-foreground data-highlighted:focus-visible:bg-accent data-highlighted:focus-visible:text-accent-foreground";

  const openAddDialog = () => {
    openAddProjectScriptEditor({
      ...(onRefreshFileScripts ? { refreshFileScripts: onRefreshFileScripts } : {}),
      openEditor: () => setEditorRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT }),
    });
  };

  const openEditDialog = (script: ProjectScript) => {
    setActionsMenuOpen(false);
    setEditorRequest(editorRequestForScript(script, keybindings));
  };

  const submitScript = useCallback(
    (scriptId: string | null, input: NewProjectScriptInput) =>
      scriptId === null ? onAddScript(input) : onUpdateScript(scriptId, input),
    [onAddScript, onUpdateScript],
  );

  const migrateLegacyScripts = async () => {
    const result = await onMigrateLegacyScripts();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not migrate actions",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
      return;
    }
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: "Actions migrated to styal.json" });
    }
  };

  const legacyMigrationMenuItem = hasLegacyConfig && (
    <>
      {primaryScript && <MenuSeparator />}
      <MenuItem className={dropdownItemClassName} onClick={() => void migrateLegacyScripts()}>
        <DownloadIcon className="size-4" />
        {legacyScripts.length > 0
          ? `Migrate ${legacyScripts.length} legacy action${legacyScripts.length === 1 ? "" : "s"}`
          : "Migrate legacy config"}
      </MenuItem>
    </>
  );

  return (
    <>
      {primaryScript ? (
        <Group aria-label="Project scripts">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  className="w-7 px-0 sm:w-6 @3xl/header-actions:w-auto! @3xl/header-actions:px-[calc(--spacing(2)-1px)]"
                  aria-label={`Run ${primaryScript.name}`}
                  // The tooltip wrapper replaces data-slot="button", so themed
                  // toolbar styling needs its own hook.
                  data-toolbar-control=""
                  onClick={() => onRunScript(primaryScript)}
                />
              }
            >
              <ScriptIcon icon={primaryScript.icon} />
              <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                {primaryScript.name}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="top">Run {primaryScript.name}</TooltipPopup>
          </Tooltip>
          <GroupSeparator className="hidden @3xl/header-actions:block" />
          <Menu
            highlightItemOnHover={false}
            open={actionsMenuOpen}
            onOpenChange={(open) => {
              setActionsMenuOpen(open);
              if (open) onRefreshFileScripts?.();
            }}
          >
            <MenuTrigger
              render={<Button size="icon-xs" variant="outline" aria-label="Script actions" />}
            >
              <ChevronDownIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {scripts.map((script) => {
                const shortcutLabel = shortcutLabelForCommand(
                  keybindings,
                  commandForProjectScript(script.id),
                );
                return (
                  <MenuItem
                    key={script.id}
                    className={`group ${dropdownItemClassName}`}
                    onClick={() => onRunScript(script)}
                  >
                    <ScriptIcon icon={script.icon} className="size-4" />
                    <span className="truncate">
                      {script.runOnWorktreeCreate ? `${script.name} (setup)` : script.name}
                    </span>
                    <span className="relative ms-auto flex h-6 min-w-6 items-center justify-end">
                      {shortcutLabel && (
                        <MenuShortcut className="ms-0 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
                          {shortcutLabel}
                        </MenuShortcut>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute right-0 top-1/2 size-6 -translate-y-1/2 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto"
                        aria-label={`Edit ${script.name}`}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          openEditDialog(script);
                        }}
                      >
                        <SettingsIcon className="size-3.5" />
                      </Button>
                    </span>
                  </MenuItem>
                );
              })}
              {legacyMigrationMenuItem}
              <MenuSeparator />
              <MenuItem className={dropdownItemClassName} onClick={openAddDialog}>
                <PlusIcon className="size-4" />
                Add action
              </MenuItem>
            </MenuPopup>
          </Menu>
        </Group>
      ) : hasLegacyConfig ? (
        <Menu
          highlightItemOnHover={false}
          open={actionsMenuOpen}
          onOpenChange={(open) => {
            setActionsMenuOpen(open);
            if (open) onRefreshFileScripts?.();
          }}
        >
          <MenuTrigger render={<Button size="xs" variant="outline" aria-label="Project actions" />}>
            <PlusIcon className="size-3.5" />
            <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
              Add action
            </span>
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            {legacyMigrationMenuItem}
            <MenuItem className={dropdownItemClassName} onClick={openAddDialog}>
              <PlusIcon className="size-4" />
              Add action
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                className="w-7 px-0 sm:w-6 @3xl/header-actions:w-auto! @3xl/header-actions:px-[calc(--spacing(2)-1px)]"
                aria-label="Add action"
                // The tooltip wrapper replaces data-slot="button", so themed
                // toolbar styling needs its own hook.
                data-toolbar-control=""
                onClick={openAddDialog}
              />
            }
          >
            <PlusIcon className="size-3.5" />
            <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
              Add action
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">Add action</TooltipPopup>
        </Tooltip>
      )}

      <ProjectScriptEditorDialog
        request={editorRequest}
        scripts={editorScripts}
        onSubmit={submitScript}
        onDelete={(scriptId) => void onDeleteScript(scriptId)}
        onClose={() => setEditorRequest(null)}
      />
    </>
  );
}
