import {
  ArrowRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  FolderIcon,
  LoaderCircleIcon,
  MonitorIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useId, useMemo } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { ClaudeAI, OpenAI, type Icon } from "../Icons";
import { Button } from "../ui/button";
import { ProjectFavicon } from "../ProjectFavicon";
import { Checkbox } from "../ui/checkbox";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import type {
  ComputerImportSummary,
  ImportComputerOption,
  ImportPreferencesModel,
  ImportProjectRow,
  ImportSource,
  ImportSourceModel,
  LegacyImportStage,
} from "./types";

function formatCount(value: number): string {
  return value.toLocaleString();
}

function plural(value: number, singular: string, many = `${singular}s`): string {
  return `${formatCount(value)} ${value === 1 ? singular : many}`;
}

/** CLI rows carry the mark of the tool the conversations came from. */
const PROVIDER_ICONS: Record<"claudeAgent" | "codex", Icon> = {
  claudeAgent: ClaudeAI,
  codex: OpenAI,
};

const PROVIDER_LABELS: Record<"claudeAgent" | "codex", string> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
};

function providerSummary(providers: readonly ("claudeAgent" | "codex")[]): string {
  return `${providers.map((provider) => PROVIDER_LABELS[provider]).join(" and ")} history`;
}

/**
 * Two value columns while the card is narrow, with the setting name spanning them,
 * and a name column joining from `@md` up. Header and rows share it so columns align.
 */
const PREFERENCE_GRID_COLUMNS =
  "grid-cols-2 @md/prefs:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)]";

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
 * live tally, then the project rows. The source name is the page heading, so the
 * strip spends its width on the control instead of repeating it. Every state
 * (scanning, empty, failed) stays inside this section.
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
      <h3 id={headingId} className="sr-only">
        {source.title}
      </h3>
      <div className="flex min-h-11 min-w-0 items-center gap-2.5 border-b border-border/60 bg-muted/20 px-3 py-2">
        <label
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3",
            disabled || total === 0 ? "cursor-default" : "cursor-pointer",
          )}
        >
          <Checkbox
            checked={allSelected}
            indeterminate={selectedCount > 0 && !allSelected}
            disabled={disabled || total === 0}
            onCheckedChange={selectAll}
            aria-label={`${allSelected ? "Deselect" : "Select"} all ${source.title} projects`}
          />
          <span
            className={cn(
              "min-w-0 truncate text-[13px] font-medium",
              total === 0 ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {source.title === "T3 Code (yngatech)" ? source.title : "Select all"}
          </span>
        </label>
        {total > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatCount(selectedCount)} of {formatCount(total)}
            <span aria-hidden> · </span>
            <span className="sr-only">, </span>
            {plural(selectedThreads, "thread")}
          </span>
        ) : null}
        <Button
          size="icon-micro"
          variant="ghost-muted"
          className="ml-1 shrink-0"
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
            const providers = project.providers ?? [];
            return (
              <label
                key={project.id}
                className={cn(
                  "flex min-w-0 items-center gap-3 px-3 py-2.5 transition-colors has-[:focus-visible]:bg-muted/40 motion-reduce:transition-none",
                  disabled ? "cursor-default" : "cursor-pointer hover:bg-muted/30",
                )}
              >
                <Checkbox
                  checked={project.selected}
                  disabled={disabled}
                  onCheckedChange={(checked) => toggleProject(project, checked === true)}
                />
                <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                  {providers.length > 0 ? (
                    <>
                      {providers.map((provider) => {
                        const ProviderIcon = PROVIDER_ICONS[provider];
                        return <ProviderIcon key={provider} className="size-3.5" aria-hidden />;
                      })}
                      <span className="sr-only">{providerSummary(providers)}</span>
                    </>
                  ) : project.legacyFavicon ? (
                    <span aria-hidden>
                      <ProjectFavicon
                        environmentId={project.legacyFavicon.environmentId}
                        legacyProjectId={project.legacyFavicon.projectId}
                        className="size-3.5"
                      />
                    </span>
                  ) : (
                    <FolderIcon className="size-3.5" aria-hidden />
                  )}
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
 * The preferences step: one opt-in checkbox in the strip, then the exact
 * before/after values for every setting the import would change.
 */
export function ImportPreferencesView({
  preferences,
  disabled,
}: {
  preferences: ImportPreferencesModel;
  disabled: boolean;
}) {
  const titleId = useId();
  const changes = useMemo(
    () => preferences.changes.filter(({ changed }) => changed),
    [preferences.changes],
  );
  const hasChanges = changes.length > 0;
  const checked = preferences.selected && hasChanges;
  const error = preferences.error ?? null;

  if (preferences.matches && !hasChanges && error === null) {
    return (
      <section role="status" className="rounded-lg border border-border/60 bg-card">
        <SourceNote icon={<CheckIcon className="size-3.5 text-primary" aria-hidden />}>
          Preferences already match
        </SourceNote>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={titleId}
      className="@container/prefs overflow-hidden rounded-lg border border-border/60 bg-card"
    >
      <div className="flex min-h-11 min-w-0 items-center gap-2.5 border-b border-border/60 bg-muted/20 px-3 py-2">
        <label
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3",
            disabled || !hasChanges ? "cursor-default" : "cursor-pointer",
          )}
        >
          <Checkbox
            checked={checked}
            disabled={disabled || !hasChanges}
            onCheckedChange={(value) => preferences.select(value === true)}
            aria-labelledby={titleId}
          />
          <span
            id={titleId}
            className={cn(
              "min-w-0 text-[13px] font-medium",
              hasChanges ? "text-foreground" : "text-muted-foreground",
            )}
          >
            Bring over T3 Code preferences
          </span>
        </label>
        {hasChanges ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {plural(changes.length, "change")}
          </span>
        ) : null}
      </div>

      {hasChanges ? (
        <>
          {/* Visual column headers only; every cell carries its own screen-reader label. */}
          <div
            aria-hidden
            className={cn(
              "grid items-center gap-x-4 border-b border-border/60 px-3 py-2 text-[11px] font-medium tracking-[0.02em] text-muted-foreground/80 uppercase",
              PREFERENCE_GRID_COLUMNS,
            )}
          >
            <span className="hidden @md/prefs:block">Setting</span>
            <span>Now</span>
            <span>After import</span>
          </div>
          <dl className="divide-y divide-border/60">
            {changes.map(({ row, current }) => (
              <div
                key={row.id}
                className={cn(
                  "grid items-baseline gap-x-4 gap-y-1 px-3 py-3",
                  PREFERENCE_GRID_COLUMNS,
                )}
              >
                <dt className="col-span-2 min-w-0 text-[13px] leading-[1.5] text-foreground @md/prefs:col-span-1">
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
        </>
      ) : null}

      {error !== null ? (
        <SourceNote tone="error" icon={<TriangleAlertIcon className="size-3.5" aria-hidden />}>
          {error}
        </SourceNote>
      ) : null}
      {preferences.message ? <SourceNote>{preferences.message}</SourceNote> : null}
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
        ? "Preferences included"
        : `Preferences on ${plural(summary.preferences, "computer")}`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "Nothing selected";
}

/**
 * The import surface itself: a heading that names what is under review — the
 * source while projects are picked, Preferences on its own step; one scroller for
 * the chosen computer; one footer that always states the whole selection and
 * commits it. Setup and Settings render the shared content; setup reaches this
 * view once per top-level step, Settings shows every section on one page.
 */
export function ImportDataView({
  computers,
  activeId,
  onSelectComputer,
  summary,
  busy,
  setup,
  source,
  stage,
  onContinue,
  checkingPreferences,
  onBack,
  progress,
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
  source: ImportSource | null;
  stage: LegacyImportStage;
  onContinue?: (() => void) | undefined;
  checkingPreferences: boolean;
  onBack?: (() => void) | undefined;
  progress: string | null;
  onImport: () => void;
  onSkip: () => void;
  message: string | null;
  error: string | null;
  children: ReactNode;
}) {
  const legacy = source === "legacy";
  const back = onBack;
  const importing = busy && progress !== null;
  const canImport = summary.projects > 0 || summary.preferences > 0;
  const computerItems = useMemo(
    () => computers.map((computer) => ({ value: computer.id, label: computer.label })),
    [computers],
  );

  return (
    // Both steps occupy the same viewport-bounded height so their controls stay in place.
    <div
      className={cn(
        "@container/import flex min-h-0 w-full flex-col",
        setup ? "h-[min(40rem,calc(100dvh-14rem))] shrink-0" : "gap-4",
      )}
      aria-busy={busy || undefined}
    >
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-2 pb-4">
        {back ? (
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="-ml-1.5 shrink-0"
            onClick={back}
            disabled={busy}
            aria-label={stage === "preferences" ? "Back to projects" : "Back to import sources"}
          >
            <ChevronLeftIcon />
          </Button>
        ) : null}
        <h2
          className={cn(
            "min-w-0 flex-1 font-semibold tracking-[-0.015em] text-foreground",
            setup ? "text-lg" : "text-base",
          )}
        >
          {setup && stage === "preferences"
            ? "Preferences"
            : legacy
              ? "T3 Code"
              : "Claude Code / Codex"}
        </h2>
      </div>

      <ScrollArea
        scrollFade
        scrollbarGutter
        className="min-h-0 flex-1 rounded-none [&_[data-slot=scroll-area-scrollbar]]:opacity-100"
      >
        <div className="flex min-w-0 flex-col gap-4 pb-1">
          {importing ? (
            // The footer's live region already announces `progress`; this block is
            // the visual anchor only, so it must not repeat the announcement.
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-foreground">Importing data</h3>
              <p className="text-[13px] leading-[1.45] text-muted-foreground">{progress}</p>
            </div>
          ) : computers.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-muted-foreground">
              No computers connected.
            </p>
          ) : computers.length === 1 ? (
            <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <MonitorIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{computers[0]?.label}</span>
            </p>
          ) : (
            <div className="flex min-w-0 items-center gap-2.5">
              {/* The trigger carries the same name for assistive tech. */}
              <span
                aria-hidden
                className="shrink-0 text-[11px] font-medium tracking-[0.04em] text-muted-foreground/80 uppercase"
              >
                Computer
              </span>
              <Select
                items={computerItems}
                value={activeId ?? null}
                disabled={busy}
                onValueChange={(value) => {
                  if (value !== null) onSelectComputer(value as EnvironmentId);
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Computer"
                  className="min-w-0 flex-1 @md/import:max-w-72"
                >
                  <MonitorIcon className="size-3.5 shrink-0" aria-hidden />
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {computers.map((computer) => (
                    <SelectItem key={computer.id} value={computer.id}>
                      <span className="flex min-w-0 items-center gap-2">
                        <MonitorIcon className="size-3.5 shrink-0" aria-hidden />
                        <span className="min-w-0 truncate">{computer.label}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          )}

          {/* Gap, not space-y: hidden computers are not flex items, so no stray margins. */}
          <div className="flex min-w-0 flex-col gap-3">{children}</div>
        </div>
      </ScrollArea>

      <div className="flex shrink-0 flex-col gap-2.5 border-t border-border/60 pt-3 @md/import:flex-row @md/import:items-center @md/import:gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <p
            className="flex min-w-0 items-center gap-1.5 text-xs leading-[1.45] tabular-nums text-muted-foreground"
            aria-live="polite"
          >
            {busy && progress !== null ? (
              <>
                <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" aria-hidden />
                <span className="min-w-0 truncate">{progress}</span>
              </>
            ) : (
              <span className="min-w-0 break-words">{summaryText(summary)}</span>
            )}
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
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {setup && stage === "projects" ? (
            <Button variant="ghost" onClick={onSkip} disabled={busy || checkingPreferences}>
              {onContinue ? "Skip projects" : "Skip for now"}
            </Button>
          ) : null}
          {onContinue ? (
            <Button onClick={onContinue} disabled={busy || checkingPreferences}>
              {checkingPreferences ? (
                <LoaderCircleIcon className="animate-spin" aria-hidden />
              ) : null}
              {checkingPreferences ? "Checking preferences…" : "Continue"}
            </Button>
          ) : (
            <Button
              onClick={onImport}
              disabled={busy || checkingPreferences || (!setup && !canImport)}
            >
              {busy || checkingPreferences ? (
                <LoaderCircleIcon className="animate-spin" aria-hidden />
              ) : null}
              {busy
                ? "Importing…"
                : checkingPreferences
                  ? "Checking preferences…"
                  : setup
                    ? canImport
                      ? "Import & finish"
                      : "Finish"
                    : "Import"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
