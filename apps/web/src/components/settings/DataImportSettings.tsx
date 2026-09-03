import {
  ArrowRightIcon,
  DatabaseIcon,
  FolderInputIcon,
  InfoIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  EnvironmentId,
  LegacyImportPreview,
  LegacyImportRequest,
  LegacyImportResult,
  LegacyImportSettingsResult,
  LegacyImportSourceKind,
  LegacyImportUnavailableReason,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { cn } from "../../lib/utils";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  importLegacyData,
  legacyImportPendingCount,
  legacyImportPreview,
} from "../../state/dataImport";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import { ProjectFavicon } from "../ProjectFavicon";
import { StyalWordmark } from "../sidebar/SidebarChrome";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildPreferenceComparisonRows,
  LEGACY_IMPORT_PREFERENCE_COUNT,
  legacyImportPreviewsEqual,
  selectLegacyImportPreferences,
} from "./DataImportSettings.logic";
import { providerSettingsTabClassName } from "./providerSettingsTabs";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const SOURCE_LABELS: Readonly<Record<LegacyImportSourceKind, string>> = {
  "t3-code": "T3 Code",
  "t3-code-yngatech": "T3 Code (yngatech)",
};

const UNAVAILABLE_COPY: Readonly<
  Record<LegacyImportUnavailableReason, { readonly title: string; readonly description: string }>
> = {
  "current-database": {
    title: "This is already your live data",
    description:
      "This server already runs on the T3 data in the default T3 home, so there is nothing separate to import.",
  },
  "unsupported-database": {
    title: "Data found, but its format isn’t supported",
    description:
      "The T3 database in the default T3 home was written by a different version. Update that installation, then rescan.",
  },
  "unreadable-database": {
    title: "Data found, but it couldn’t be opened",
    description:
      "The T3 database in the default T3 home couldn’t be read. Check its file permissions and the old installation, then rescan.",
  },
};

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatThreadCount(value: number): string {
  return `${formatCount(value)} ${value === 1 ? "thread" : "threads"}`;
}

function formatProjectCount(value: number): string {
  return `${formatCount(value)} ${value === 1 ? "project" : "projects"}`;
}

function formatScriptCount(value: number): string {
  return `${formatCount(value)} ${value === 1 ? "script" : "scripts"}`;
}

function formatSettingCount(value: number): string {
  return `${formatCount(value)} ${value === 1 ? "setting" : "settings"}`;
}

function formatAttachmentCount(value: number): string {
  return `${formatCount(value)} ${value === 1 ? "attachment" : "attachments"}`;
}

function importFailureMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "The selected data could not be imported.";
}

/** Concise completion summary for the projects toast and any retryable inline result. */
function projectImportSummaryText(result: LegacyImportResult): string {
  const skippedProjectCount = result.projects.filter(
    (project) => project.status === "skipped",
  ).length;
  const parts: string[] = [];
  if (result.importedProjectCount > 0 || result.importedThreadCount > 0) {
    parts.push(
      `${formatProjectCount(result.importedProjectCount)} and ${formatThreadCount(result.importedThreadCount)} imported`,
    );
  }
  if (skippedProjectCount > 0) {
    parts.push(`${formatProjectCount(skippedProjectCount)} already here`);
  }
  if (result.skippedAttachmentCount > 0) {
    parts.push(`${formatAttachmentCount(result.skippedAttachmentCount)} unavailable and skipped`);
  }
  if (parts.length === 0) {
    return "Nothing new to bring over";
  }
  return parts.join(" · ");
}

/**
 * Comparison grid: two value columns on narrow screens (the label spans both above
 * them), and a label column joins them from `sm` up. Header and rows share this so
 * the columns stay aligned.
 */
const PREFERENCE_GRID_COLUMNS =
  "grid-cols-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]";

function valueClassName(monospace: boolean | undefined): string {
  return monospace ? "break-all font-mono text-xs" : "break-words tabular-nums";
}

function useStableLegacyImportPreview(
  value: LegacyImportPreview | null,
): LegacyImportPreview | null {
  const stable = useRef(value);
  if (!legacyImportPreviewsEqual(stable.current, value)) {
    stable.current = value;
  }
  return stable.current;
}

/** Shared frame for every resolved preview state so the states share one rhythm. */
function PreviewSourceCard({
  statusDotClassName,
  title,
  meta,
  badge,
  description,
  children,
}: {
  readonly statusDotClassName?: string;
  readonly title: string;
  readonly meta?: ReactNode;
  readonly badge?: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-3 sm:px-4">
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {statusDotClassName ? (
            <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
              <DatabaseIcon className="size-4.5 text-foreground/80" aria-hidden />
              <span
                className={cn(
                  "pointer-events-none absolute -top-0.5 -left-0.5 size-2 rounded-full ring-2 ring-background",
                  statusDotClassName,
                )}
                aria-hidden
              />
            </span>
          ) : null}
          <span className="min-w-0 truncate text-sm font-medium tracking-[-0.005em] text-foreground">
            {title}
          </span>
          {meta}
          {badge}
        </div>
        {description ? (
          <p className="max-w-xl text-[13px] leading-[1.45] text-muted-foreground/80">
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function PreviewSkeleton() {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 px-3 sm:px-4">
        <Skeleton className="size-4 rounded" />
        <Skeleton className="h-4.5 w-44 rounded-full" />
      </div>
      <div className="px-3 sm:px-4">
        <Skeleton className="h-4 w-24 rounded-full" />
        <div className="mt-3 overflow-hidden rounded-lg border border-border/60 bg-card">
          <div className="flex items-center gap-3 border-b border-border/60 bg-muted/20 px-3 py-2">
            <Skeleton className="h-3.5 w-28 rounded-full" />
            <Skeleton className="ml-auto h-3.5 w-24 rounded-full" />
          </div>
          <div className="divide-y divide-border/60">
            {["one", "two", "three"].map((row) => (
              <div key={row} className="flex items-center gap-3 px-3 py-2.5">
                <Skeleton className="size-4 rounded" />
                <Skeleton className="size-5 rounded-[5px]" />
                <Skeleton className="h-3.5 w-36 rounded-full" />
                <Skeleton className="ml-auto h-3.5 w-24 rounded-full" />
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Skeleton className="h-8 w-36 rounded-lg" />
        </div>
      </div>
      <div className="px-3 sm:px-4">
        <Skeleton className="h-4 w-28 rounded-full" />
        <div className="mt-3 divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 bg-card">
          {["one", "two", "three"].map((row) => (
            <div key={row} className="flex items-center gap-3 px-3 py-2.5">
              <Skeleton className="h-3.5 w-40 rounded-full" />
              <Skeleton className="ml-auto h-3.5 w-20 rounded-full" />
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <Skeleton className="h-8 w-40 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

function RescanButton({
  isPending,
  disabled = false,
  onRescan,
}: {
  readonly isPending: boolean;
  readonly disabled?: boolean;
  readonly onRescan: () => void;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-8 gap-1.5 px-3 text-xs"
      onClick={onRescan}
      disabled={disabled || isPending}
    >
      <RefreshCwIcon className={cn("size-3.5", isPending && "animate-spin")} />
      {isPending ? "Rescanning…" : "Rescan"}
    </Button>
  );
}

function PreviewEmptyState({
  icon,
  title,
  description,
  action,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <Empty className="min-h-64 rounded-xl border border-border/60 bg-muted/20">
      <EmptyMedia variant="icon">{icon}</EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

/**
 * One import surface: what it would bring over, then the single button that brings
 * it. Projects and preferences are flat page sections under the source heading — the
 * bounded surface belongs to the list or table inside, not to the section itself.
 */
function ImportPanel({
  title,
  description,
  children,
  hint,
  action,
  feedback,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly hint?: ReactNode;
  readonly action: ReactNode;
  readonly feedback?: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="px-3 sm:px-4">
      <h4 id={titleId} className="text-sm font-medium tracking-[-0.005em] text-foreground">
        {title}
      </h4>
      {description ? (
        <p className="mt-1 max-w-xl text-[13px] leading-[1.45] text-muted-foreground/80">
          {description}
        </p>
      ) : null}
      {children}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
        {hint ? (
          <p className="min-w-48 flex-1 text-xs leading-[1.45] text-muted-foreground/80">{hint}</p>
        ) : null}
        {action}
      </div>
      {feedback}
    </section>
  );
}

/** Compact stand-in when the source has no readable preferences to preview. */
function PreferencesUnavailableCard({
  tone,
  title,
  description,
}: {
  readonly tone: "muted" | "warning";
  readonly title: string;
  readonly description: string;
}) {
  const Icon = tone === "warning" ? TriangleAlertIcon : InfoIcon;
  return (
    <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-border/60 bg-card px-3 py-3">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "warning" ? "text-warning" : "text-muted-foreground/70",
        )}
        aria-hidden
      />
      <div className="min-w-0 space-y-0.5">
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        <p className="text-[13px] leading-[1.45] text-muted-foreground/80">{description}</p>
      </div>
    </div>
  );
}

function AvailablePreview({
  preview,
  serverLabel,
  environmentId,
  isImporting,
  onImport,
  onRefresh,
}: {
  readonly preview: Extract<LegacyImportPreview, { status: "available" }>;
  readonly serverLabel: string;
  readonly environmentId: EnvironmentId;
  readonly isImporting: boolean;
  readonly onImport: (
    input: LegacyImportRequest,
  ) => Promise<AtomCommandResult<LegacyImportResult, unknown>>;
  readonly onRefresh: () => void;
}) {
  const currentPreferenceValues = useEnvironmentSettings(
    environmentId,
    selectLegacyImportPreferences,
  );
  const [selectedProjectIds, setSelectedProjectIds] = useState(
    () => new Set(preview.projects.map((project) => project.projectId)),
  );
  const knownProjectIds = useRef(new Set(preview.projects.map((project) => project.projectId)));
  // One request at a time, but each action keeps its own outcome so the feedback
  // always names the button that ran.
  const [runningAction, setRunningAction] = useState<"projects" | "preferences" | null>(null);
  const [projectsResult, setProjectsResult] = useState<LegacyImportResult | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [preferencesResult, setPreferencesResult] = useState<LegacyImportSettingsResult | null>(
    null,
  );
  const [preferencesError, setPreferencesError] = useState<string | null>(null);

  useEffect(() => {
    if (isImporting) return;
    const previousProjectIds = knownProjectIds.current;
    const nextProjectIds = new Set(preview.projects.map((project) => project.projectId));
    knownProjectIds.current = nextProjectIds;
    setSelectedProjectIds((current) => {
      const next = new Set(
        preview.projects.flatMap((project) =>
          current.has(project.projectId) || !previousProjectIds.has(project.projectId)
            ? [project.projectId]
            : [],
        ),
      );
      return next.size === current.size && [...next].every((projectId) => current.has(projectId))
        ? current
        : next;
    });
  }, [isImporting, preview.projects]);

  // Group headings inside the one scroller, so each heading can label its own rows.
  const transferGroupId = useId();
  const existingGroupId = useId();
  const existingGroupNoteId = useId();

  const sourceLabel = SOURCE_LABELS[preview.sourceKind];
  // Backend sort order is meaningful, so each group keeps it.
  const newProjects = useMemo(
    () => preview.projects.filter((project) => !project.isExistingProject),
    [preview.projects],
  );
  const existingProjects = useMemo(
    () => preview.projects.filter((project) => project.isExistingProject),
    [preview.projects],
  );
  const allProjectsSelected = selectedProjectIds.size === preview.projects.length;
  const noProjectsSelected = selectedProjectIds.size === 0;
  const selectedThreadCount = preview.projects.reduce(
    (count, project) =>
      selectedProjectIds.has(project.projectId) ? count + project.threadCount : count,
    0,
  );

  const preferencesPreview = preview.preferences;
  const preferenceValues =
    preferencesPreview?.status === "available" ? preferencesPreview.values : null;
  const preferenceComparisonRows = useMemo(
    () =>
      preferenceValues === null
        ? []
        : buildPreferenceComparisonRows(preferenceValues, currentPreferenceValues),
    [currentPreferenceValues, preferenceValues],
  );

  const toggleProject = (projectId: string, selected: boolean) => {
    setSelectedProjectIds((current) => {
      const next = new Set(current);
      if (selected) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
  };

  const handleImportProjects = async () => {
    setProjectsError(null);
    setProjectsResult(null);
    setRunningAction("projects");
    try {
      const result = await onImport({
        projectIds: Array.from(selectedProjectIds),
        includeSettings: false,
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          setProjectsError(importFailureMessage(squashAtomCommandFailure(result)));
        }
        return;
      }
      setProjectsResult(result.value);
      // Only the failures stay selected, so a second click retries exactly them.
      setSelectedProjectIds(
        new Set(
          result.value.projects
            .filter((project) => project.status === "failed")
            .map((project) => project.sourceProjectId),
        ),
      );
      const hasFailure = result.value.projects.some((project) => project.status === "failed");
      // Clean runs (including the "already imported" no-op) get a toast instead of
      // taking over the page; anything retryable stays on the page below.
      if (!hasFailure) {
        const nothingChanged =
          result.value.importedProjectCount === 0 && result.value.importedThreadCount === 0;
        toastManager.add({
          type: "success",
          title: nothingChanged ? `${serverLabel} already has these projects` : "Projects imported",
          description: projectImportSummaryText(result.value),
        });
      }
      onRefresh();
    } catch (error) {
      setProjectsError(importFailureMessage(error));
    } finally {
      setRunningAction(null);
    }
  };

  const handleImportPreferences = async () => {
    setPreferencesError(null);
    setPreferencesResult(null);
    setRunningAction("preferences");
    try {
      const result = await onImport({
        projectIds: [],
        includeSettings: true,
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          setPreferencesError(importFailureMessage(squashAtomCommandFailure(result)));
        }
        return;
      }
      const settingsResult: LegacyImportSettingsResult = result.value.settings ?? {
        status: "not-found",
      };
      setPreferencesResult(settingsResult);
      if (settingsResult.status === "imported") {
        toastManager.add({
          type: "success",
          title: "Preferences imported",
          description: `${formatSettingCount(LEGACY_IMPORT_PREFERENCE_COUNT)} on ${serverLabel} now match ${sourceLabel}.`,
        });
      }
    } catch (error) {
      setPreferencesError(importFailureMessage(error));
    } finally {
      setRunningAction(null);
    }
  };

  const failedProjects =
    projectsResult?.projects.filter((project) => project.status === "failed") ?? [];
  const failedProjectCount = failedProjects.length;
  const projectsImported = projectsResult !== null && failedProjectCount === 0;
  const canImportProjects = !isImporting && selectedProjectIds.size > 0;
  const projectsButtonLabel = (() => {
    if (runningAction === "projects") return "Importing projects…";
    if (selectedProjectIds.size === 0) {
      return projectsImported ? "Projects imported" : "Import projects";
    }
    const verb = failedProjectCount > 0 ? "Retry" : "Import";
    return `${verb} ${formatProjectCount(selectedProjectIds.size)}`;
  })();
  // The list header already counts the selection, so the footer only speaks up when
  // there is nothing to import yet.
  const projectsHint =
    preview.projects.length > 0 && selectedProjectIds.size === 0
      ? projectsImported
        ? "Select a project to import it again."
        : "Select at least one project to import."
      : undefined;

  /** One selectable project row; `meta` states exactly what that row would move. */
  const renderProjectRow = (
    project: (typeof preview.projects)[number],
    meta: ReactNode,
  ): ReactNode => {
    const selected = selectedProjectIds.has(project.projectId);
    const projectTitle = project.title.trim() || "Untitled project";
    const importFailed = failedProjects.some(
      (failed) => failed.sourceProjectId === project.projectId,
    );
    return (
      <label
        key={project.projectId}
        className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/30 has-[:focus-visible]:bg-muted/40 motion-reduce:transition-none"
      >
        <Checkbox
          checked={selected}
          disabled={isImporting}
          onCheckedChange={(checked) => toggleProject(project.projectId, checked === true)}
          aria-label={`${selected ? "Deselect" : "Select"} ${projectTitle}`}
        />
        <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[5px] bg-muted/40">
          <ProjectFavicon
            environmentId={environmentId}
            legacyProjectId={project.projectId}
            className="size-3.5"
          />
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px] font-medium",
            selected ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {projectTitle}
        </span>
        {importFailed ? (
          <span className="shrink-0 text-xs font-medium text-warning">Didn’t import</span>
        ) : null}
        {/* Capped so a long count pair wraps inside itself instead of squeezing the name. */}
        <span className="flex max-w-[55%] shrink-0 flex-wrap justify-end gap-x-1.5 text-right text-xs tabular-nums text-muted-foreground">
          {meta}
        </span>
      </label>
    );
  };

  const preferencesImported = preferencesResult?.status === "imported";
  const changedPreferenceCount = preferenceComparisonRows.filter(({ changed }) => changed).length;
  const preferencesMatch = preferenceValues !== null && changedPreferenceCount === 0;
  const canImportPreferences = !isImporting && preferenceValues !== null && !preferencesMatch;

  return (
    <div className="space-y-3" aria-busy={isImporting}>
      <div
        inert={isImporting}
        aria-disabled={isImporting || undefined}
        className={cn(
          "space-y-5 transition-opacity duration-150 motion-reduce:transition-none",
          isImporting && "opacity-64 select-none [&_label]:cursor-default",
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 sm:px-4">
          <h3 className="min-w-0 truncate text-base font-semibold tracking-[-0.015em] text-foreground">
            {sourceLabel}
          </h3>
        </div>

        <ImportPanel
          title="Projects"
          hint={projectsHint}
          action={
            <Button onClick={() => void handleImportProjects()} disabled={!canImportProjects}>
              {runningAction === "projects" ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <FolderInputIcon />
              )}
              {projectsButtonLabel}
            </Button>
          }
          feedback={
            <>
              {projectsError !== null ? (
                <Alert variant="error" className="mt-3">
                  <TriangleAlertIcon />
                  <AlertTitle>Project import failed</AlertTitle>
                  <AlertDescription>{projectsError}</AlertDescription>
                </Alert>
              ) : null}
              {projectsResult !== null && failedProjectCount > 0 ? (
                <Alert variant="warning" controlAlignment="first-line" className="mt-3">
                  <TriangleAlertIcon />
                  <AlertTitle>
                    {`${formatCount(failedProjectCount)} ${failedProjectCount === 1 ? "project needs" : "projects need"} another try`}
                  </AlertTitle>
                  <AlertDescription>
                    <span>{projectImportSummaryText(projectsResult)}.</span>
                    <ul className="space-y-0.5">
                      {failedProjects.slice(0, 3).map((project) => (
                        <li key={project.sourceProjectId} className="min-w-0">
                          <span className="font-medium">
                            {project.title.trim() || "Untitled project"}
                          </span>
                          {project.detail ? ` — ${project.detail}` : null}
                        </li>
                      ))}
                      {failedProjects.length > 3 ? (
                        <li>+{formatCount(failedProjects.length - 3)} more</li>
                      ) : null}
                    </ul>
                    <span>The failed projects stay selected, so you can retry just those.</span>
                  </AlertDescription>
                </Alert>
              ) : null}
            </>
          }
        >
          <div className="mt-3 overflow-hidden rounded-lg border border-border/60 bg-card">
            <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 bg-muted/20 px-3 py-2">
              <Checkbox
                checked={allProjectsSelected}
                indeterminate={!allProjectsSelected && !noProjectsSelected}
                disabled={preview.projects.length === 0 || isImporting}
                onCheckedChange={() =>
                  setSelectedProjectIds(
                    allProjectsSelected
                      ? new Set()
                      : new Set(preview.projects.map((project) => project.projectId)),
                  )
                }
                aria-label={allProjectsSelected ? "Deselect all projects" : "Select all projects"}
              />
              <span className="text-xs font-medium text-foreground">Select all</span>
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                {formatCount(selectedProjectIds.size)} of {formatCount(preview.projects.length)}{" "}
                selected
                <span aria-hidden> · </span>
                {formatThreadCount(selectedThreadCount)}
              </span>
            </div>
            {preview.projects.length === 0 ? (
              <p className="px-3 py-4 text-[13px] text-muted-foreground/80">
                This installation has no projects to import.
              </p>
            ) : (
              <ScrollArea
                scrollFade
                scrollbarGutter
                className="max-h-72 [&_[data-slot=scroll-area-scrollbar]]:opacity-100"
              >
                {/* The grouping states the scope: what moves whole, and what only gains threads. */}
                <div className="divide-y divide-border/60">
                  {existingProjects.length > 0 ? (
                    <div
                      role="group"
                      aria-labelledby={existingGroupId}
                      aria-describedby={existingGroupNoteId}
                    >
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border/60 bg-muted/20 px-3 py-2">
                        <h5
                          id={existingGroupId}
                          className="min-w-0 text-xs font-semibold tracking-[-0.005em] text-foreground"
                        >
                          Import threads into existing projects
                        </h5>
                        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                          {formatProjectCount(existingProjects.length)}
                        </span>
                        <p
                          id={existingGroupNoteId}
                          className="basis-full text-xs leading-[1.45] text-muted-foreground/80"
                        >
                          Adds missing threads and keeps the project settings already in styal.
                        </p>
                      </div>
                      <div className="divide-y divide-border/60">
                        {existingProjects.map((project) =>
                          renderProjectRow(
                            project,
                            <span className="whitespace-nowrap">
                              {formatThreadCount(project.threadCount)}
                            </span>,
                          ),
                        )}
                      </div>
                    </div>
                  ) : null}
                  {newProjects.length > 0 ? (
                    <div role="group" aria-labelledby={transferGroupId}>
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border/60 bg-muted/20 px-3 py-2">
                        <h5
                          id={transferGroupId}
                          className="min-w-0 text-xs font-semibold tracking-[-0.005em] text-foreground"
                        >
                          Transfer projects
                        </h5>
                        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                          {formatProjectCount(newProjects.length)}
                        </span>
                      </div>
                      <div className="divide-y divide-border/60">
                        {newProjects.map((project) =>
                          renderProjectRow(
                            project,
                            <>
                              <span className="whitespace-nowrap">
                                {formatThreadCount(project.threadCount)}
                              </span>
                              <span className="sr-only">, </span>
                              <span aria-hidden className="text-muted-foreground/50">
                                ·
                              </span>
                              <span className="whitespace-nowrap">
                                {formatScriptCount(project.scriptCount)}
                              </span>
                            </>,
                          ),
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              </ScrollArea>
            )}
          </div>
        </ImportPanel>

        <ImportPanel
          title="Preferences"
          action={
            <Button
              variant={preferencesMatch ? "secondary" : "default"}
              onClick={() => void handleImportPreferences()}
              disabled={!canImportPreferences}
            >
              {runningAction === "preferences" ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <SlidersHorizontalIcon />
              )}
              {runningAction === "preferences"
                ? "Importing preferences…"
                : preferencesMatch
                  ? "Preferences match"
                  : preferencesImported
                    ? "Import preferences again"
                    : "Import preferences"}
            </Button>
          }
          feedback={
            <>
              {preferencesError !== null ? (
                <Alert variant="error" className="mt-3">
                  <TriangleAlertIcon />
                  <AlertTitle>Preference import failed</AlertTitle>
                  <AlertDescription>{preferencesError}</AlertDescription>
                </Alert>
              ) : null}
              {preferencesResult !== null && preferencesResult.status !== "imported" ? (
                <Alert variant="warning" controlAlignment="first-line" className="mt-3">
                  <TriangleAlertIcon />
                  <AlertTitle>
                    {preferencesResult.status === "failed"
                      ? "Preferences need another try"
                      : "No preferences were found"}
                  </AlertTitle>
                  <AlertDescription>
                    <span>
                      {preferencesResult.detail ??
                        (preferencesResult.status === "failed"
                          ? "They couldn’t be applied this time. Try the import again."
                          : "The old installation no longer has a settings file. Rescan to check again.")}
                    </span>
                  </AlertDescription>
                </Alert>
              ) : null}
            </>
          }
        >
          {preferencesPreview === undefined ? (
            <PreferencesUnavailableCard
              tone="muted"
              title="Preview unavailable"
              description="This server didn’t report any preference values. Rescan to try again."
            />
          ) : preferencesPreview.status === "not-found" ? (
            <PreferencesUnavailableCard
              tone="muted"
              title="No preferences to import"
              description="This installation never saved app preferences. Your projects can still be imported above."
            />
          ) : preferencesPreview.status === "unreadable" ? (
            <PreferencesUnavailableCard
              tone="warning"
              title="Settings file couldn’t be read"
              description="Fix or replace the settings file in the old installation, then rescan. Your projects can still be imported above."
            />
          ) : (
            <div className="mt-3 overflow-hidden rounded-lg border border-border/60 bg-card">
              {/* Visual column headers only; each cell carries its own screen-reader label. */}
              <div
                aria-hidden
                className={cn(
                  "grid min-h-10 items-center gap-x-4 border-b border-border/60 bg-muted/20 px-3 py-2 text-xs",
                  PREFERENCE_GRID_COLUMNS,
                )}
              >
                <span className="hidden font-medium text-foreground sm:block">Setting</span>
                <span className="font-medium text-foreground">Current in styal</span>
                <span className="font-medium text-foreground">After import</span>
              </div>
              <ScrollArea
                scrollFade
                scrollbarGutter
                className="max-h-72 [&_[data-slot=scroll-area-scrollbar]]:opacity-100"
              >
                <dl className="divide-y divide-border/60">
                  {preferenceComparisonRows.map(({ row, current, changed }) => {
                    return (
                      <div
                        key={row.id}
                        className={cn(
                          "grid items-baseline gap-x-4 gap-y-0.5 px-3 py-2",
                          PREFERENCE_GRID_COLUMNS,
                          changed && "bg-muted/30",
                        )}
                      >
                        <dt
                          className={cn(
                            "col-span-2 min-w-0 text-[13px] leading-[1.5] sm:col-span-1",
                            changed ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {row.label}
                        </dt>
                        <dd
                          className={cn(
                            "min-w-0 text-[13px] leading-[1.5]",
                            changed ? "text-foreground/70" : "text-muted-foreground",
                            valueClassName(current?.monospace ?? row.monospace),
                          )}
                        >
                          <span className="sr-only">Current in styal: </span>
                          {current?.value ?? "—"}
                        </dd>
                        <dd
                          className={cn(
                            "min-w-0 text-[13px] leading-[1.5]",
                            changed ? "font-medium text-foreground" : "text-muted-foreground",
                            valueClassName(row.monospace),
                          )}
                        >
                          <span className="sr-only">
                            {changed ? "After import: " : "After import (unchanged): "}
                          </span>
                          {changed ? (
                            <ArrowRightIcon
                              className="mr-1 inline-block size-3 -translate-y-px align-middle text-primary/80"
                              aria-hidden
                            />
                          ) : null}
                          {row.value}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </ScrollArea>
            </div>
          )}
        </ImportPanel>
      </div>
    </div>
  );
}

const MemoizedAvailablePreview = memo(
  AvailablePreview,
  (previous, next) =>
    previous.preview === next.preview &&
    previous.serverLabel === next.serverLabel &&
    previous.environmentId === next.environmentId &&
    previous.isImporting === next.isImporting,
);

export function DataImportSettingsPanel() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    primaryEnvironmentId,
  );
  const environment =
    environments.find(({ environmentId }) => environmentId === selectedEnvironmentId) ??
    environments.find(({ environmentId }) => environmentId === primaryEnvironmentId) ??
    environments.find(({ connection }) => connection.phase === "connected") ??
    environments[0] ??
    null;
  const environmentId = environment?.environmentId ?? null;
  const isConnected = environment?.connection.phase === "connected";
  const preview = useEnvironmentQuery(
    environmentId === null ? null : legacyImportPreview({ environmentId, input: {} }),
  );
  const latestPreviewData = useStableLegacyImportPreview(preview.data);
  const serverLabel = environment?.label ?? "the connected server";
  const runImportCommand = useAtomCommand(importLegacyData, {
    label: "import T3 Code data",
    reportFailure: false,
  });
  // Command-owned state outlives every preview state. A failed poll, transient
  // disconnect, or settings-page remount cannot unlock this while the promise runs.
  const pendingImportCount = useAtomValue(legacyImportPendingCount);
  const isImporting = pendingImportCount > 0;
  const retainedAvailablePreview = useRef<Extract<
    LegacyImportPreview,
    { status: "available" }
  > | null>(null);
  if (!isImporting && latestPreviewData?.status === "available") {
    retainedAvailablePreview.current = latestPreviewData;
  }
  const previewData =
    isImporting && retainedAvailablePreview.current !== null
      ? retainedAvailablePreview.current
      : latestPreviewData;
  const isInitialScanPending = preview.isPending && previewData === null;
  const handleImport = useCallback(
    async (input: LegacyImportRequest) => {
      if (environmentId === null) {
        throw new Error("The import environment is no longer available.");
      }
      return runImportCommand({ environmentId, input });
    },
    [environmentId, runImportCommand],
  );
  const [isRescanning, setIsRescanning] = useState(false);
  useEffect(() => {
    if (!preview.isPending) {
      setIsRescanning(false);
    }
  }, [preview.isPending]);
  const canRescan = environmentId !== null && isConnected;
  const handleRescan = useCallback(() => {
    setIsRescanning(true);
    preview.refresh();
  }, [preview]);

  const rescanHeaderButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            onClick={handleRescan}
            disabled={!canRescan || isInitialScanPending || isRescanning || isImporting}
            aria-label="Rescan for importable data"
          >
            <RefreshCwIcon className={cn("size-3", isRescanning && "animate-spin")} />
          </Button>
        }
      />
      <TooltipPopup side="top">
        {isImporting ? "Available once the import finishes" : "Rescan the connected server"}
      </TooltipPopup>
    </Tooltip>
  );

  const environmentTabs =
    environments.length > 1 ? (
      <ScrollArea hideScrollbars scrollFade className="h-11 min-w-0 rounded-none">
        <div
          role="group"
          aria-label="Servers"
          className="flex h-full w-max min-w-full border-b border-border/70 px-3 sm:px-4"
        >
          {environments.map((candidate) => {
            const selected = candidate.environmentId === environmentId;
            return (
              <button
                key={candidate.environmentId}
                type="button"
                aria-pressed={selected}
                disabled={isImporting}
                className={cn(
                  providerSettingsTabClassName(selected),
                  "gap-2 disabled:pointer-events-none disabled:opacity-64",
                )}
                onClick={() => setSelectedEnvironmentId(candidate.environmentId)}
              >
                <ServerIcon className="size-3.5 shrink-0" aria-hidden />
                <span className="max-w-40 truncate">{candidate.label}</span>
                <ConnectionStatusDot
                  dotClassName={connectionPhaseDotClassName(candidate.connection.phase)}
                  pingClassName={connectionPhasePingClassName(candidate.connection.phase)}
                />
              </button>
            );
          })}
        </div>
      </ScrollArea>
    ) : null;

  const body = (() => {
    if (environmentId === null) {
      return (
        <PreviewEmptyState
          icon={<ServerIcon />}
          title="No connected server"
          description="Connect a server from Connections, then come back to check it for existing T3 Code data."
        />
      );
    }

    if (!isConnected && !(isImporting && previewData?.status === "available")) {
      return (
        <PreviewEmptyState
          icon={<ServerIcon />}
          title={`Waiting for ${serverLabel}`}
          description="This check runs on the connected server. It starts on its own once the connection is back."
        />
      );
    }

    if (previewData === null && preview.error !== null) {
      return (
        <PreviewEmptyState
          icon={<DatabaseIcon />}
          title="Could not check for importable data"
          description={preview.error}
          action={<RescanButton isPending={isRescanning} onRescan={handleRescan} />}
        />
      );
    }

    const data: LegacyImportPreview | null = previewData;
    if (data === null || isInitialScanPending) {
      return <PreviewSkeleton />;
    }

    if (data.status === "available") {
      return (
        <MemoizedAvailablePreview
          key={`${environmentId}:${data.sourceKind}`}
          preview={data}
          serverLabel={serverLabel}
          environmentId={environmentId}
          isImporting={isImporting}
          onImport={handleImport}
          onRefresh={preview.refresh}
        />
      );
    }

    if (data.status === "not-found") {
      return (
        <PreviewEmptyState
          icon={<DatabaseIcon />}
          title="No importable data found"
          description="No T3 Code data in the default T3 home. This check only looks there, so an installation kept somewhere else won’t show up."
          action={<RescanButton isPending={isRescanning} onRescan={handleRescan} />}
        />
      );
    }

    const unavailable = UNAVAILABLE_COPY[data.reason];
    const isCurrentDatabase = data.reason === "current-database";
    return (
      <PreviewSourceCard
        statusDotClassName={isCurrentDatabase ? "bg-muted-foreground/35" : "bg-warning"}
        title={unavailable.title}
        badge={
          <Badge variant={isCurrentDatabase ? "secondary" : "warning"} size="sm">
            {isCurrentDatabase ? "Not an import source" : "Needs attention"}
          </Badge>
        }
        description={unavailable.description}
      >
        {isCurrentDatabase ? null : (
          <div className="mt-3">
            <RescanButton isPending={isRescanning} onRescan={handleRescan} />
          </div>
        )}
      </PreviewSourceCard>
    );
  })();

  return (
    <SettingsPageContainer>
      <SettingsSection
        id={searchableSetting("import-data").id}
        title="Import data"
        headerAction={rescanHeaderButton}
      >
        <p className="max-w-2xl px-3 pt-1 pb-5 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
          Pick up where you left off in T3 Code by importing your projects and preferences{" "}
          <span className="whitespace-nowrap">
            into{" "}
            <StyalWordmark className="inline-block h-[1em] w-auto align-[-0.24em] text-foreground" />
            .
          </span>
        </p>
        {environmentTabs}
        <div
          className="pt-5"
          aria-live="polite"
          aria-busy={isInitialScanPending || isRescanning || isImporting}
        >
          {body}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
