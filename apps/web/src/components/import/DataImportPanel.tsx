import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { dataImportBatchPendingCount, legacyImportPendingCount } from "../../state/dataImport";
import { LegacyImportComputer, HistoryImportComputer } from "./ImportComputer";
import { ImportSourceChooser } from "./ImportSourceChooser";
import { ImportDataView, plural } from "./ImportDataView";
import { importErrorMessage } from "./useLegacyImport";
import type {
  ComputerImporter,
  ComputerImportSummary,
  ImportSource,
  LegacyImportStage,
} from "./types";

/**
 * Runs the chosen project source and optional T3 preferences across selected computers.
 * Setup commits each step when it is left; Settings imports the whole page at once.
 */
export function DataImportPanel({
  active = true,
  environmentIds,
  source,
  onBack,
  onDone,
  onBusyChange,
  stage = "projects",
  onSourceChange,
  onContinue,
  onPreferencesAvailable,
}: {
  /** Whether setup is showing this panel; focus only moves into a visible step. */
  active?: boolean;
  environmentIds?: readonly EnvironmentId[];
  source: ImportSource | null;
  stage?: LegacyImportStage;
  onSourceChange?: (source: ImportSource | null) => void;
  onContinue?: () => void;
  onPreferencesAvailable?: (available: boolean) => void;
  onBack?: () => void;
  onDone?: (projectRef?: ScopedProjectRef) => Promise<boolean>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { environments: allEnvironments } = useEnvironments();
  const environments = environmentIds
    ? allEnvironments.filter((environment) => environmentIds.includes(environment.environmentId))
    : allEnvironments;
  const primary = usePrimaryEnvironmentId();
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(primary);
  const activeId =
    environments.find((environment) => environment.environmentId === selectedId)?.environmentId ??
    environments[0]?.environmentId;
  const historyImporters = useRef(new Map<EnvironmentId, ComputerImporter>());
  const importers = useRef(new Map<EnvironmentId, ComputerImporter>());
  const [summaries, setSummaries] = useState<ReadonlyMap<EnvironmentId, ComputerImportSummary>>(
    new Map(),
  );
  const onSummary = useCallback((id: EnvironmentId, summary: ComputerImportSummary) => {
    setSummaries((current) => new Map(current).set(id, summary));
  }, []);
  const [historySummaries, setHistorySummaries] = useState<
    ReadonlyMap<EnvironmentId, ComputerImportSummary>
  >(new Map());
  const onHistorySummary = useCallback((id: EnvironmentId, summary: ComputerImportSummary) => {
    setHistorySummaries((current) => new Map(current).set(id, summary));
  }, []);
  const preferencesAvailable = environments.some(
    (environment) => (summaries.get(environment.environmentId)?.preferenceChanges ?? 0) > 0,
  );
  const preferencesPending = environments.some(
    (environment) => summaries.get(environment.environmentId)?.previewPending !== false,
  );
  // Setup only leads on to Preferences once discovery found values that differ.
  const nextStep = !!onDone && stage === "projects" && preferencesAvailable;
  useEffect(() => {
    onPreferencesAvailable?.(preferencesAvailable);
  }, [onPreferencesAvailable, preferencesAvailable]);
  const historyStep = source === "history" && stage === "projects";
  const summary = environments.reduce(
    (total, environment) => {
      const next = summaries.get(environment.environmentId);
      const history = historyStep ? historySummaries.get(environment.environmentId) : undefined;
      return {
        projects: total.projects + (next?.projects ?? 0) + (history?.projects ?? 0),
        threads: total.threads + (next?.threads ?? 0) + (history?.threads ?? 0),
        preferences: total.preferences + (next?.preferences ?? 0),
      };
    },
    { projects: 0, threads: 0, preferences: 0 },
  );
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const registry = useContext(RegistryContext);
  const pending =
    useAtomValue(legacyImportPendingCount) + useAtomValue(dataImportBatchPendingCount);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [progress, setProgress] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [landing, setLanding] = useState<ScopedProjectRef>();
  const [awaitingCompletion, setAwaitingCompletion] = useState(false);
  const [finishing, setFinishing] = useState(false);
  // Only an import shows per-computer progress; a skip leaves the step as it was.
  const [skipped, setSkipped] = useState(false);
  const importing = progress !== null || (awaitingCompletion && !skipped);
  const projects = useProjects();
  const busy = running || pending > 0 || awaitingCompletion || finishing;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  // A command receipt may precede the workspace projection needed by navigation.
  useEffect(() => {
    if (!awaitingCompletion || !onDone) return;
    if (
      landing &&
      !projects.some(
        (project) =>
          project.id === landing.projectId && project.environmentId === landing.environmentId,
      )
    )
      return;
    setAwaitingCompletion(false);
    setFinishing(true);
    void onDone(landing)
      .catch((failure) => setError(importErrorMessage(failure)))
      .finally(() => setFinishing(false));
  }, [awaitingCompletion, landing, onDone, projects]);
  const run = async () => {
    if (busy || runningRef.current) return;
    runningRef.current = true;
    setSkipped(false);
    registry.update(dataImportBatchPendingCount, (count) => count + 1);
    setRunning(true);
    setError(null);
    setMessage(null);
    let success = true;
    let firstProject = landing;
    const failures: string[] = [];
    try {
      const batch = environments.flatMap((environment) => [
        ...(historyStep
          ? [{ environment, importer: historyImporters.current.get(environment.environmentId) }]
          : []),
        { environment, importer: importers.current.get(environment.environmentId) },
      ]);
      for (const { environment, importer } of batch) {
        if (!mounted.current) return;
        if (!importer) {
          success = false;
          continue;
        }
        try {
          setProgress(`Importing from ${environment.label}…`);
          const result = await importer.run();
          if (!result.success) {
            success = false;
            failures.push(environment.label);
          }
          firstProject ??= result.projectRef;
        } catch (failure) {
          success = false;
          failures.push(`${environment.label}: ${importErrorMessage(failure)}`);
        }
      }
      setLanding(firstProject);
      if (!success)
        setError(
          `Some data could not be imported${failures.length ? ` on ${failures.join(", ")}` : ""}. Retry the remaining selection.`,
        );
      else if (!onDone) setMessage("Import complete.");
      else if (nextStep) {
        setMessage(`Imported ${plural(summary.projects, "project")}.`);
        onContinue?.();
      } else setAwaitingCompletion(true);
    } finally {
      registry.update(dataImportBatchPendingCount, (count) => Math.max(0, count - 1));
      runningRef.current = false;
      setRunning(false);
      setProgress(null);
    }
  };
  /** Leaves the current step without importing it; earlier steps stay imported. */
  const skip = () => {
    if (!onDone || busy || runningRef.current) return;
    setSkipped(true);
    setError(null);
    if (stage === "projects") onSourceChange?.(null);
    if (nextStep) onContinue?.();
    else setAwaitingCompletion(true);
  };

  // Changing views removes or hides the control that was pressed, so hand focus to
  // the matching action in the next view once it can take it, without pulling focus
  // off a control the user has already reached. After a skip, Enter skips again.
  // Selection counts arrive a render late, so a fallback focus is provisional.
  const rootRef = useRef<HTMLDivElement>(null);
  const firstSourceRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const view = source === null && stage === "projects" ? "sources" : stage;
  const focusedView = useRef<string | null>(null);
  const provisionalFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active || !onDone) {
      focusedView.current = null;
      return;
    }
    if (focusedView.current === view) return;
    const current = document.activeElement;
    if (
      current instanceof HTMLElement &&
      current !== provisionalFocus.current &&
      current.matches("button, input") &&
      rootRef.current?.contains(current) &&
      current.checkVisibility()
    ) {
      focusedView.current = view;
      return;
    }
    const [preferred, fallback] =
      view === "sources"
        ? [firstSourceRef.current, null]
        : skipped
          ? [skipRef.current, primaryRef.current]
          : [primaryRef.current, skipRef.current];
    if (preferred && !preferred.disabled) {
      preferred.focus();
      focusedView.current = view;
      provisionalFocus.current = null;
    } else if (fallback && !fallback.disabled) {
      fallback.focus();
      provisionalFocus.current = fallback;
    }
  });
  return (
    <div ref={rootRef} className="contents">
      {view === "sources" ? (
        <ImportSourceChooser
          firstSourceRef={firstSourceRef}
          onSelect={(next) => onSourceChange?.(next)}
          onSkip={skip}
          busy={busy}
          skipDisabled={preferencesPending}
          skipLabel={
            preferencesPending
              ? "Checking preferences…"
              : preferencesAvailable
                ? "Skip projects"
                : "Skip for now"
          }
          error={error}
        />
      ) : null}
      <div hidden={view === "sources"}>
        <ImportDataView
          computers={environments.map((environment) => ({
            id: environment.environmentId,
            label: environment.label,
          }))}
          activeId={activeId}
          onSelectComputer={setSelectedId}
          summary={summary}
          busy={busy}
          setup={!!onDone}
          source={source}
          stage={stage}
          nextStep={nextStep}
          checkingPreferences={!!onDone && stage === "projects" && preferencesPending}
          finishing={awaitingCompletion || finishing}
          onBack={onBack}
          progress={progress ?? (importing ? "Finishing setup…" : null)}
          onImport={() => void run()}
          onSkip={skip}
          primaryRef={primaryRef}
          skipRef={skipRef}
          message={message}
          error={error}
        >
          {source === "history"
            ? environments.map((environment) => (
                <HistoryImportComputer
                  key={environment.environmentId}
                  environmentId={environment.environmentId}
                  label={environment.label}
                  active={activeId === environment.environmentId && stage === "projects"}
                  connected={environment.connection.phase === "connected"}
                  busy={busy}
                  setup={!!onDone}
                  importing={historyStep && importing}
                  onSummary={onHistorySummary}
                  ref={(importer) => {
                    if (importer) historyImporters.current.set(environment.environmentId, importer);
                    else historyImporters.current.delete(environment.environmentId);
                  }}
                />
              ))
            : null}
          {environments.map((environment) => (
            <LegacyImportComputer
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
              active={
                activeId === environment.environmentId &&
                (source === "legacy" || stage === "preferences")
              }
              includeProjects={source === "legacy"}
              connected={environment.connection.phase === "connected"}
              busy={busy}
              setup={!!onDone}
              importing={importing}
              stage={stage}
              onSummary={onSummary}
              ref={(importer) => {
                if (importer) importers.current.set(environment.environmentId, importer);
                else importers.current.delete(environment.environmentId);
              }}
            />
          ))}
        </ImportDataView>
      </div>
    </div>
  );
}
