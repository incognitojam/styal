import {
  ArrowRightIcon,
  ChevronRightIcon,
  FolderIcon,
  LoaderCircleIcon,
  MonitorIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import type {
  ComputerImportSummary,
  ImportComputerOption,
  ImportPreferencesModel,
  ImportProjectRow,
  ImportSourceModel,
} from "./types";

function formatCount(value: number): string {
  return value.toLocaleString();
}

function plural(value: number, singular: string, many = `${singular}s`): string {
  return `${formatCount(value)} ${value === 1 ? singular : many}`;
}

/**
 * Two value columns on narrow screens with the setting name spanning them, and a
 * name column joining from `sm` up. Header and rows share it so columns align.
 */
const PREFERENCE_GRID_COLUMNS =
  "grid-cols-2 sm:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)]";

function valueClassName(monospace: boolean | undefined): string {
  return monospace ? "break-all font-mono text-xs" : "break-words tabular-nums";
}

/** Quiet single line used for every non-row state a section can be in. */
function SourceNote({
  tone = "muted",
  icon,
  children,
  action,
}: {
  readonly tone?: "muted" | "error";
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2.5 text-[13px] leading-[1.45]",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
      {...(tone === "error" ? { role: "alert" as const } : {})}
    >
      {icon ? (
        <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      ) : null}
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {action}
    </div>
  );
}

/**
 * One import source: a header strip that doubles as the select-all control and the
 * live tally, then the project rows. Every state (scanning, empty, failed) stays
 * inside this section so a broken source never takes the other sources down.
 */
export function ImportSourceView({
  source,
  disabled,
}: {
  source: ImportSourceModel;
  disabled: boolean;
}) {
  const headingId = useId();
  const projects = source.projects;
  const total = projects.length;
  const selectedProjects = projects.filter((project) => project.selected);
  const selectedCount = selectedProjects.length;
  const selectedThreads = selectedProjects.reduce((sum, project) => sum + project.threads, 0);
  const allSelected = total > 0 && selectedCount === total;
  const error = source.error ?? null;

  // A path only earns a line of its own when it is the thing telling two rows apart.
  const repeatedTitles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) {
      counts.set(project.title, (counts.get(project.title) ?? 0) + 1);
    }
    return counts;
  }, [projects]);

  const selectAll = () => {
    source.select(allSelected ? new Set() : new Set(projects.map((project) => project.id)));
  };

  const toggleProject = (project: ImportProjectRow, checked: boolean) => {
    const next = new Set(selectedProjects.map((selected) => selected.id));
    if (checked) next.add(project.id);
    else next.delete(project.id);
    source.select(next);
  };

  return (
    <section
      aria-labelledby={headingId}
      className="overflow-hidden rounded-lg border border-border/60 bg-card"
    >
      <div className="flex min-h-10 min-w-0 items-center gap-2.5 border-b border-border/60 bg-muted/20 px-3 py-2">
        <Checkbox
          checked={allSelected}
          indeterminate={selectedCount > 0 && !allSelected}
          disabled={disabled || total === 0}
          onCheckedChange={selectAll}
          aria-label={`${allSelected ? "Deselect" : "Select"} all ${source.title} projects`}
        />
        <h3
          id={headingId}
          className="min-w-0 flex-1 text-[13px] font-semibold tracking-[-0.005em] text-foreground"
        >
          {source.title}
        </h3>
        {total > 0 ? (
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatCount(selectedCount)} of {formatCount(total)}
            <span aria-hidden> · </span>
            <span className="sr-only">, </span>
            {plural(selectedThreads, "thread")}
          </span>
        ) : null}
        <Button
          size="icon-micro"
          variant="ghost-muted"
          className={cn("shrink-0", total > 0 ? "ml-1.5" : "ml-auto")}
          onClick={source.refresh}
          disabled={disabled || source.pending}
          aria-label={`Rescan ${source.title}`}
        >
          <RefreshCwIcon className={cn("size-3", source.pending && "animate-spin")} />
        </Button>
      </div>

      {error !== null ? (
        <SourceNote
          tone="error"
          icon={<TriangleAlertIcon className="size-3.5" aria-hidden />}
          action={
            <Button
              size="compact"
              variant="outline"
              onClick={source.refresh}
              disabled={disabled || source.pending}
            >
              Retry
            </Button>
          }
        >
          {error}
        </SourceNote>
      ) : null}

      {source.notice ? <SourceNote>{source.notice}</SourceNote> : null}

      {total > 0 ? (
        <div className="divide-y divide-border/60">
          {projects.map((project) => {
            const title = project.title.trim() || "Untitled project";
            const path = project.path.trim();
            const showPath = path.length > 0 && (repeatedTitles.get(project.title) ?? 0) > 1;
            return (
              <label
                key={project.id}
                className={cn(
                  "flex min-w-0 items-center gap-3 px-3 py-2 transition-colors has-[:focus-visible]:bg-muted/40 motion-reduce:transition-none",
                  disabled ? "cursor-default" : "cursor-pointer hover:bg-muted/30",
                )}
              >
                <Checkbox
                  checked={project.selected}
                  disabled={disabled}
                  onCheckedChange={(checked) => toggleProject(project, checked === true)}
                />
                <span
                  aria-hidden
                  className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-muted/40 text-muted-foreground"
                >
                  <FolderIcon className="size-3.5" />
                </span>
                <Tooltip>
                  <TooltipTrigger render={<span className="flex min-w-0 flex-1 flex-col" />}>
                    <span
                      className={cn(
                        "truncate text-[13px] font-medium",
                        project.selected ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {title}
                    </span>
                    {showPath ? (
                      <span className="truncate font-mono text-[11px] text-muted-foreground/80">
                        {path}
                      </span>
                    ) : null}
                  </TooltipTrigger>
                  <TooltipPopup className="max-w-96 break-all font-mono">
                    {path || title}
                  </TooltipPopup>
                </Tooltip>
                <span className="flex max-w-[52%] shrink-0 flex-wrap justify-end gap-x-1.5 text-right text-xs tabular-nums text-muted-foreground">
                  <span className="whitespace-nowrap">{plural(project.threads, "thread")}</span>
                  {project.detail ? (
                    <>
                      <span className="sr-only">, </span>
                      <span aria-hidden className="text-muted-foreground/50">
                        ·
                      </span>
                      <span className="min-w-0 break-words">{project.detail}</span>
                    </>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      ) : source.pending ? (
        <SourceNote icon={<LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />}>
          Scanning…
        </SourceNote>
      ) : source.message ? (
        <SourceNote>{source.message}</SourceNote>
      ) : error === null ? (
        <SourceNote>Nothing to import here.</SourceNote>
      ) : null}
    </section>
  );
}

/**
 * Preferences ride along with the projects: one optional checkbox, and the exact
 * before/after values behind a disclosure for anyone who wants to check them.
 */
export function ImportPreferencesView({
  preferences,
  disabled,
}: {
  preferences: ImportPreferencesModel;
  disabled: boolean;
}) {
  const titleId = useId();
  const detailId = useId();
  const [expanded, setExpanded] = useState(false);
  const changes = useMemo(
    () => preferences.changes.filter(({ changed }) => changed),
    [preferences.changes],
  );
  const hasChanges = changes.length > 0;
  const open = expanded && hasChanges;
  const checked = preferences.selected && hasChanges;
  const error = preferences.error ?? null;

  return (
    <section className="overflow-hidden rounded-lg border border-border/60 bg-card">
      <div className="flex min-w-0 items-start gap-3 px-3 py-2.5">
        <label
          className={cn(
            "flex min-w-0 flex-1 items-start gap-3",
            disabled || !hasChanges ? "cursor-default" : "cursor-pointer",
          )}
        >
          <Checkbox
            className="mt-px"
            checked={checked}
            disabled={disabled || !hasChanges}
            onCheckedChange={(value) => preferences.select(value === true)}
            aria-labelledby={titleId}
          />
          <span className="min-w-0">
            <span
              id={titleId}
              className={cn(
                "block text-[13px] font-medium",
                hasChanges ? "text-foreground" : "text-muted-foreground",
              )}
            >
              Bring over T3 Code preferences
            </span>
            <span className="block text-xs leading-[1.45] text-muted-foreground">
              <span className="break-words">{preferences.computer}</span>
              <span aria-hidden> · </span>
              <span className="sr-only">, </span>
              {hasChanges ? plural(changes.length, "change") : "no changes"}
            </span>
          </span>
        </label>
        {hasChanges ? (
          <Button
            size="compact"
            variant="ghost-muted"
            className="shrink-0"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setExpanded((current) => !current)}
          >
            <ChevronRightIcon
              className={cn(
                "transition-transform motion-reduce:transition-none",
                open && "rotate-90",
              )}
              aria-hidden
            />
            Review changes
          </Button>
        ) : null}
      </div>

      {hasChanges ? (
        <div id={detailId} hidden={!open} className="border-t border-border/60 bg-muted/10">
          {/* Visual column headers only; every cell carries its own screen-reader label. */}
          <div
            aria-hidden
            className={cn(
              "grid items-center gap-x-4 border-b border-border/60 px-3 py-1.5 text-[11px] font-medium tracking-[0.02em] text-muted-foreground/80 uppercase",
              PREFERENCE_GRID_COLUMNS,
            )}
          >
            <span className="hidden sm:block">Setting</span>
            <span>Now</span>
            <span>After import</span>
          </div>
          <dl className="divide-y divide-border/60">
            {changes.map(({ row, current }) => (
              <div
                key={row.id}
                className={cn(
                  "grid items-baseline gap-x-4 gap-y-0.5 px-3 py-2",
                  PREFERENCE_GRID_COLUMNS,
                )}
              >
                <dt className="col-span-2 min-w-0 text-[13px] leading-[1.5] text-foreground sm:col-span-1">
                  {row.label}
                </dt>
                <dd
                  className={cn(
                    "min-w-0 text-[13px] leading-[1.5] text-muted-foreground",
                    valueClassName(current?.monospace ?? row.monospace),
                  )}
                >
                  <span className="sr-only">Now: </span>
                  {current?.value ?? "—"}
                </dd>
                <dd
                  className={cn(
                    "min-w-0 text-[13px] leading-[1.5] font-medium text-foreground",
                    valueClassName(row.monospace),
                  )}
                >
                  <span className="sr-only">After import: </span>
                  <ArrowRightIcon
                    className="mr-1 inline-block size-3 -translate-y-px align-middle text-primary/80"
                    aria-hidden
                  />
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {error !== null ? (
        <div className="border-t border-border/60">
          <SourceNote tone="error" icon={<TriangleAlertIcon className="size-3.5" aria-hidden />}>
            {error}
          </SourceNote>
        </div>
      ) : null}
      {preferences.message ? (
        <div className="border-t border-border/60">
          <SourceNote>{preferences.message}</SourceNote>
        </div>
      ) : null}
    </section>
  );
}

/** Totals for every computer, so the footer never hides work queued on another tab. */
function summaryText(summary: ComputerImportSummary): string {
  const parts: string[] = [];
  if (summary.projects > 0) parts.push(plural(summary.projects, "project"));
  if (summary.threads > 0) parts.push(plural(summary.threads, "thread"));
  if (summary.preferences > 0) {
    parts.push(
      summary.preferences === 1
        ? "preferences"
        : `preferences on ${plural(summary.preferences, "computer")}`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "Nothing selected";
}

/**
 * The import surface itself: one scroller for the computer's sources, one footer
 * that always states the whole selection and commits it. Setup and Settings render
 * the same thing; only the heading and the primary label differ.
 */
export function ImportDataView({
  computers,
  activeId,
  onSelectComputer,
  summary,
  busy,
  setup,
  onImport,
  onSkip,
  message,
  error,
  children,
}: {
  computers: readonly ImportComputerOption[];
  activeId: EnvironmentId | undefined;
  onSelectComputer: (id: EnvironmentId) => void;
  summary: ComputerImportSummary;
  busy: boolean;
  setup: boolean;
  onImport: () => void;
  onSkip: () => void;
  message: string | null;
  error: string | null;
  children: ReactNode;
}) {
  const computersLabelId = useId();
  const canImport = !busy && (summary.projects > 0 || summary.preferences > 0);

  return (
    /* Setup gets its height from the wizard's constrained column; Settings falls back to
       a viewport-relative ceiling, so the footer stays on screen either way. */
    <div
      className="flex max-h-[min(40rem,calc(100dvh-9rem))] min-h-0 w-full flex-1 flex-col"
      aria-busy={busy || undefined}
    >
      <ScrollArea
        scrollFade
        scrollbarGutter
        className="min-h-0 flex-1 rounded-none [&_[data-slot=scroll-area-scrollbar]]:opacity-100"
      >
        <div className="flex min-w-0 flex-col gap-4 pb-1">
          {setup ? (
            <h2 className="text-xl font-semibold tracking-[-0.02em] text-foreground">
              Bring your projects into styal
            </h2>
          ) : null}

          {computers.length > 0 ? (
            <div className="min-w-0">
              <p
                id={computersLabelId}
                className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted-foreground/80 uppercase"
              >
                Computer
              </p>
              <div
                role="group"
                aria-labelledby={computersLabelId}
                className="flex flex-col gap-1 rounded-xl bg-zinc-25 p-1 ring-1 ring-black/5 sm:flex-row dark:bg-white/4 dark:ring-white/5"
              >
                {computers.map((computer) => {
                  const active = computer.id === activeId;
                  return (
                    <button
                      key={computer.id}
                      type="button"
                      aria-pressed={active}
                      disabled={busy}
                      onClick={() => onSelectComputer(computer.id)}
                      className={cn(
                        "flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 motion-reduce:transition-none",
                        active
                          ? "bg-card text-foreground shadow-xs ring-1 ring-black/5 dark:shadow-none dark:ring-white/5"
                          : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                      )}
                    >
                      <MonitorIcon className="size-3.5 shrink-0" aria-hidden />
                      <span className="min-w-0 truncate font-medium">{computer.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="py-8 text-center text-[13px] text-muted-foreground">
              No computers connected.
            </p>
          )}

          {/* Gap, not space-y: hidden computers are not flex items, so no stray margins. */}
          <div className="flex min-w-0 flex-col gap-3">{children}</div>
        </div>
      </ScrollArea>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3 border-t border-border/60 pt-3">
        <div className="min-w-48 flex-1 space-y-1">
          <p
            className="text-xs leading-[1.45] tabular-nums text-muted-foreground"
            aria-live="polite"
          >
            {summaryText(summary)}
          </p>
          {error !== null ? (
            <p
              role="alert"
              className="flex min-w-0 items-start gap-1.5 text-xs leading-[1.45] text-destructive"
            >
              <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">{error}</span>
            </p>
          ) : null}
          {message !== null ? (
            <p className="min-w-0 text-xs leading-[1.45] break-words text-muted-foreground/80">
              {message}
            </p>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {setup ? (
            <Button variant="ghost" onClick={onSkip} disabled={busy}>
              Skip for now
            </Button>
          ) : null}
          <Button onClick={onImport} disabled={!canImport}>
            {busy ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : null}
            {busy ? "Importing…" : setup ? "Import & finish" : "Import"}
          </Button>
        </div>
      </div>
    </div>
  );
}
