import { FolderPlusIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { SidebarInput, SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  hasProjects: boolean;
  projectScope: ReactNode;
  singleProjectScope?: boolean;
  onNewProject: () => void;
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadInProjectShortcutLabel: string | null | undefined;
  showNewThreadInProjectHint: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  hasProjects,
  projectScope,
  singleProjectScope = false,
  onNewProject,
  onNewThread,
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadInProjectShortcutLabel,
  showNewThreadInProjectHint,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const resultsVisible = isSearching && searchResultCount > 0;
  // Shrinking results can remove the active option; never leave aria-activedescendant pointing at it.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  const newThreadLabel = newThreadShortcutLabel
    ? `New thread (${newThreadShortcutLabel})`
    : "New thread";

  const scopeControl = hasProjects ? (
    <div
      key="scope"
      className={singleProjectScope ? "col-span-3 row-start-1 min-w-0" : "col-start-2 row-start-1"}
    >
      {projectScope}
    </div>
  ) : null;
  const searchControl = (
    <div
      key="search"
      className={cn(
        singleProjectScope ? "col-span-2 row-start-2" : "row-start-1",
        "col-start-1 flex h-8 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/70",
      )}
    >
      <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
      <SidebarInput
        ref={searchInputRef}
        nativeInput
        type="search"
        value={searchQuery}
        onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
        onKeyDown={onSearchKeyDown}
        placeholder="Search"
        aria-label="Search threads"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={resultsVisible}
        aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
        aria-activedescendant={
          activeResultExists ? `sidebar-thread-search-result-${activeSearchResultIndex}` : undefined
        }
        className="min-w-0 flex-1"
      />
      {isSearching ? (
        <Button
          type="button"
          size="icon-micro"
          variant="ghost-muted"
          className="shrink-0"
          aria-label="Clear thread search"
          onClick={() => {
            onClearSearch();
            searchInputRef.current?.focus();
          }}
        >
          <XIcon className="size-3" />
        </Button>
      ) : null}
    </div>
  );
  const actionsControl = (
    <div
      key="actions"
      className={cn(
        "col-start-3 flex items-center",
        singleProjectScope ? "row-start-2" : "row-start-1",
      )}
    >
      {hasProjects ? (
        <SidebarHeaderIconButton label="Add project" onClick={onNewProject}>
          <FolderPlusIcon />
        </SidebarHeaderIconButton>
      ) : null}
      <SidebarHeaderIconButton
        label="New thread"
        tooltip={
          showNewThreadInProjectHint ? (
            <span className="flex flex-col gap-0.5">
              <span>{newThreadLabel}</span>
              <span className="text-muted-foreground">
                New thread in current project: Shift+click
                {newThreadInProjectShortcutLabel ? ` (${newThreadInProjectShortcutLabel})` : ""}
              </span>
            </span>
          ) : (
            newThreadLabel
          )
        }
        disabled={newThreadDisabled}
        onClick={onNewThread}
      >
        <SquarePenIcon />
      </SidebarHeaderIconButton>
    </div>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1">
      {singleProjectScope
        ? [scopeControl, searchControl, actionsControl]
        : [searchControl, scopeControl, actionsControl]}
    </div>
  );
}

export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
