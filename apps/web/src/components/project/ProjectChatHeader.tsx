import type { EnvironmentMachineKind } from "@t3tools/contracts";
import {
  CalendarClockIcon,
  MessageSquareTextIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { projectJobStatus } from "./projectPage.logic";
import { scheduleLabel } from "../settings/scheduledTasksSettings.logic";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ProjectPageJob } from "./useProjectPages";

export interface ProjectChatHeaderProps {
  readonly project: ProjectFaviconProject;
  readonly name: string;
  readonly statusLine: string | null;
  readonly machine: { readonly label: string; readonly kind: EnvironmentMachineKind } | null;
  readonly onNewThread: () => void;
  readonly onOpenSettings: () => void;
  /** Once the chat exists: its thread view, for the thread's title, menu and details panel. */
  readonly onOpenThread?: (() => void) | null;
  /** Scheduled tasks whose threads the page keeps off the sidebar, listed in a menu. */
  readonly jobs: ReadonlyArray<ProjectPageJob>;
  readonly onOpenJobThread: (thread: ProjectPageJob["thread"]) => void;
}

/** The project page's header, in the slot and height of a thread's header. */
export function ProjectChatHeader(props: ProjectChatHeaderProps & { rightPanelOpen: boolean }) {
  return (
    <div
      data-testid="project-chat-header"
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
        // Two panel toggles sit over the right edge: the project page has no details toggle.
        props.rightPanelOpen ? "pr-10" : "pr-16",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ProjectFavicon project={props.project} className="size-3.5" />
        <h2 className="min-w-0 shrink truncate text-sm font-medium text-foreground">
          {props.name}
        </h2>
        {props.statusLine ? (
          <span className="min-w-0 shrink-[2] truncate text-muted-foreground text-xs">
            {props.statusLine}
          </span>
        ) : null}
      </div>
      {props.machine ? (
        <span className="flex min-w-0 shrink items-center gap-1.5 text-muted-foreground text-xs max-sm:hidden">
          <EnvironmentMachineIcon aria-hidden kind={props.machine.kind} className="size-3.5" />
          <span className="truncate">{props.machine.label}</span>
        </span>
      ) : null}
      <Button variant="outline" size="compact" onClick={props.onNewThread}>
        <SquarePenIcon aria-hidden />
        <span className="max-sm:sr-only">New thread</span>
      </Button>
      {props.jobs.length > 0 ? (
        <Menu>
          <MenuTrigger render={<Button variant="ghost-muted" size="compact" />}>
            <CalendarClockIcon aria-hidden />
            <span className="max-sm:sr-only">Scheduled</span>
          </MenuTrigger>
          <MenuPopup align="end" sideOffset={6} className="max-w-80">
            {props.jobs.map(({ thread, task, timeZone }) => (
              <MenuItem
                key={`${thread.environmentId}:${task.id}`}
                onClick={() => props.onOpenJobThread(thread)}
              >
                <CalendarClockIcon className="mt-1 size-3.5 shrink-0 self-start" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{task.title}</span>
                  {thread.title !== task.title ? (
                    <span className="truncate text-xs text-muted-foreground">{thread.title}</span>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    <span className="whitespace-nowrap">
                      {scheduleLabel(task.schedule, timeZone, task.nextRunAt)}
                    </span>
                    {" · "}
                    <span className="whitespace-nowrap">{projectJobStatus(thread, task)}</span>
                    {task.lastRunAt ? (
                      <>
                        {" · "}
                        <span className="whitespace-nowrap">
                          started {formatRelativeTimeLabel(task.lastRunAt)}
                        </span>
                      </>
                    ) : null}
                  </span>
                </span>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
      {props.onOpenThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label="Open as thread"
                onClick={props.onOpenThread}
              />
            }
          >
            <MessageSquareTextIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Open as thread</TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label="Project settings"
              onClick={props.onOpenSettings}
            />
          }
        >
          <SettingsIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Project settings</TooltipPopup>
      </Tooltip>
    </div>
  );
}
