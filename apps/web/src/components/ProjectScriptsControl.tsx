import { useAtomValue } from "@effect/atom-react";
import { projectActions } from "../state/projectActions";
import type { EnvironmentId, ProjectId, ProjectScript, ThreadId } from "@t3tools/contracts";
import { useGT, T } from "gt-react";
import { useState } from "react";
import { ChevronDownIcon, PlayIcon } from "lucide-react";
import { useProjectActions } from "../hooks/useProjectActions";
import { ScriptIcon } from "./ScriptIcon";
import { ProjectActionSource } from "./ProjectActionSource";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "./ui/menu";
import { Badge } from "./ui/badge";

export default function ProjectScriptsControl({
  displayMode = "toolbar",
  environmentId,
  projectId,
  threadId,
  onRunScript,
}: {
  displayMode?: "toolbar" | "panel";
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId?: ThreadId;
  onRunScript?: (script: ProjectScript) => void;
}) {
  const gt = useGT();
  const actions = useProjectActions(environmentId, projectId, threadId);
  const canRun = useAtomValue(projectActions.run.permissionAtom(environmentId));
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void actions.fetch();
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant={displayMode === "panel" ? "ghost" : "outline"}
            className={displayMode === "panel" ? "w-full justify-start" : undefined}
            aria-label={gt("Project actions")}
          />
        }
      >
        <PlayIcon className="size-3.5" />
        <T>Actions</T>
        <ChevronDownIcon className={displayMode === "panel" ? "ml-auto size-3.5" : "size-3.5"} />
      </MenuTrigger>
      <MenuPopup align="end" className="max-w-sm">
        {actions.data && (
          <ProjectActionSource data={actions.data} onFetch={() => void actions.fetch()} />
        )}
        {actions.error && (
          <p role="alert" className="px-2 py-2 text-xs text-destructive">
            {actions.error}
          </p>
        )}
        {actions.data?.actions.map((action) => (
          <MenuItem
            key={action.id}
            disabled={!canRun || !onRunScript || !actions.data?.policyAllowed}
            onClick={() => onRunScript?.(action)}
          >
            <ScriptIcon icon={action.icon} />
            <MenuItemLabel>{action.name}</MenuItemLabel>
            {!action.approved && (
              <Badge size="sm" variant="warning">
                <T>Needs approval</T>
              </Badge>
            )}
          </MenuItem>
        ))}
        {actions.data?.actions.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            <T>No actions in t3.json.</T>
          </p>
        )}
      </MenuPopup>
    </Menu>
  );
}
