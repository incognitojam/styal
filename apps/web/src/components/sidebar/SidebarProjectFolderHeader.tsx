import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDownIcon, PinIcon, SquarePenIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import {
  animateSidebarLayoutChanges,
  resolveSidebarFolderDot,
  resolveThreadLastVisitedAt,
  sidebarListItemId,
} from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Kbd } from "../ui/kbd";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const FOLDER_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const FOLDER_DOT_LABEL = {
  attention: ", needs you",
  failed: ", failed",
  unread: ", done",
  working: ", working",
} as const;

/** Unscaled height of a folder header: its top gap and its 32px row. */
export const SIDEBAR_FOLDER_HEADER_HEIGHT = 40;

/** The most urgent state among threads a header stands for, as the folder dot shows it. */
function useSidebarFolderDot(threads: readonly EnvironmentThreadShell[]) {
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  return threads.length === 0
    ? null
    : resolveSidebarFolderDot(
        threads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      );
}

function SidebarFolderDot(props: { dot: ReturnType<typeof useSidebarFolderDot> }) {
  return props.dot ? (
    <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[props.dot])}>
      <span className="sr-only">{FOLDER_DOT_LABEL[props.dot]}</span>
    </span>
  ) : null;
}

/** The folder's sidebar tree row; its thread rows name it as their parent. */
export function sidebarFolderRowId(projectKey: string) {
  return `folder:${projectKey}`;
}

/**
 * A project folder in the boring sidebar. It reads like a shelf header: a trailing
 * count and chevron, with the count and a status dot only while it is closed, so a
 * closed folder still says when a hidden thread needs you.
 */
export const SidebarProjectFolderHeader = memo(function SidebarProjectFolderHeader(props: {
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  /** The project's chat, which has no row: its state joins the folder's dot. */
  chat?: EnvironmentThreadShell | null | undefined;
  /** Set while the project has a page: the name opens it and the chevron alone toggles. */
  onOpen?: ((group: SidebarProjectSnapshot) => void) | undefined;
  selected?: boolean | undefined;
  statusLine?: string | null | undefined;
  jumpLabel: string | null;
  /** Set while the route is the chat's thread, which this header stands for. */
  revealRef?: ((row: HTMLElement, threadKey: string) => (() => void) | undefined) | undefined;
  pinned: boolean;
  draggable: boolean;
  onToggle: (group: SidebarProjectSnapshot) => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  onContextMenu: (group: SidebarProjectSnapshot, position: { x: number; y: number }) => void;
}) {
  const { group, collapsed, hiddenThreads } = props;
  const rowId = sidebarFolderRowId(group.projectKey);
  // Moves with its rows while a thread is dragged; dragging it reorders projects.
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sidebarListItemId({ kind: "project-header", group: group.projectKey }),
    disabled: { draggable: !props.draggable },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  const dot = useSidebarFolderDot([
    ...(collapsed ? hiddenThreads : []),
    ...(props.chat ? [props.chat] : []),
  ]);
  return (
    <li
      ref={setNodeRef}
      data-testid="sidebar-project-folder"
      className={cn(
        "group/project-folder relative list-none pt-2 first:pt-0",
        isDragging && "z-20",
      )}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        visibility: !isDragging && transform?.scaleY === 0 ? "hidden" : undefined,
      }}
      // Here, not on the name, so the chevron and New thread open the folder's menu too.
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu(group, { x: event.clientX, y: event.clientY });
      }}
    >
      <button
        {...listeners}
        type="button"
        ref={(row) =>
          row && props.revealRef && props.chat
            ? props.revealRef(
                row,
                scopedThreadKey(scopeThreadRef(props.chat.environmentId, props.chat.id)),
              )
            : undefined
        }
        data-sidebar-row={rowId}
        aria-expanded={!collapsed}
        aria-current={props.selected ? "page" : undefined}
        onClick={() => (props.onOpen ? props.onOpen(group) : props.onToggle(group))}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.selected && "bg-sidebar-row-active",
          isDragging && "bg-sidebar-row-hover",
        )}
      >
        <ProjectFavicon project={group} className="size-4 shrink-0" />
        {props.pinned ? (
          <PinIcon aria-label="Pinned" className="-ml-1 size-3 shrink-0 text-muted-foreground" />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {group.displayName}
        </span>
        {props.jumpLabel ? (
          <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end group-has-[[data-sidebar-toggle-for]:focus-visible]/project-folder:invisible group-has-[[data-sidebar-action-for]:focus-visible]/project-folder:invisible">
            <Kbd aria-hidden data-jump-hint>
              {props.jumpLabel}
            </Kbd>
          </span>
        ) : (
          <>
            {props.statusLine ? (
              <span className="shrink-0 text-xs text-sidebar-muted-foreground group-hover/project-folder:invisible pointer-coarse:invisible">
                {props.statusLine}
              </span>
            ) : null}
            {/* The New thread action takes this place on hover, as it does the count's. */}
            <span className="contents group-hover/project-folder:hidden pointer-coarse:hidden">
              <SidebarFolderDot dot={dot} />
            </span>
            {collapsed && hiddenThreads.length > 0 ? (
              <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/project-folder:invisible pointer-coarse:invisible">
                {hiddenThreads.length}
              </span>
            ) : null}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
                collapsed && "-rotate-90",
                props.onOpen && "invisible",
              )}
            />
          </>
        )}
      </button>
      {props.onOpen ? (
        <button
          type="button"
          data-sidebar-toggle-for={rowId}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Open" : "Close"} the ${group.displayName} folder`}
          onClick={() => props.onToggle(group)}
          className={cn(
            "absolute right-0 bottom-0 flex h-8 w-6 cursor-pointer items-center justify-end rounded-(--control-radius) pr-(--sidebar-row-content-inset) outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            props.jumpLabel && "opacity-0 focus-visible:opacity-100",
          )}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
              collapsed && "-rotate-90",
            )}
          />
        </button>
      ) : null}
      {/* Sits over the count, which hides on hover, and left of the chevron. */}
      <span
        className={cn(
          "absolute right-6 bottom-0 flex h-8 items-center opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100",
          props.jumpLabel && "opacity-0! focus-within:opacity-100!",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                data-sidebar-action-for={rowId}
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`New thread in ${group.displayName}`}
                onClick={() => props.onNewThread(group)}
              />
            }
          >
            <SquarePenIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup>New thread in {group.displayName}</TooltipPopup>
        </Tooltip>
      </span>
    </li>
  );
});
