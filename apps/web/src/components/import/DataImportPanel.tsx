import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { dataImportBatchPendingCount, legacyImportPendingCount } from "../../state/dataImport";
import { ImportComputer } from "./ImportComputer";
import { ImportDataView } from "./ImportDataView";
import { importErrorMessage } from "./useLegacyImport";
import type { ComputerImporter, ComputerImportSummary } from "./types";

/** Setup and Settings use the same mounted importers; only scope and completion differ. */
export function DataImportPanel({
  environmentIds,
  onDone,
  onBusyChange,
}: {
  environmentIds?: readonly EnvironmentId[];
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
  const importers = useRef(new Map<EnvironmentId, ComputerImporter>());
  const [summaries, setSummaries] = useState<ReadonlyMap<EnvironmentId, ComputerImportSummary>>(
    new Map(),
  );
  const onSummary = useCallback((id: EnvironmentId, summary: ComputerImportSummary) => {
    setSummaries((current) => new Map(current).set(id, summary));
  }, []);
  const summary = environments.reduce(
    (total, environment) => {
      const next = summaries.get(environment.environmentId);
      return {
        projects: total.projects + (next?.projects ?? 0),
        threads: total.threads + (next?.threads ?? 0),
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
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [landing, setLanding] = useState<ScopedProjectRef>();
  const [awaitingCompletion, setAwaitingCompletion] = useState(false);
  const projects = useProjects();
  const busy = running || pending > 0 || awaitingCompletion;
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
    setRunning(true);
    void onDone(landing)
      .catch((failure) => setError(importErrorMessage(failure)))
      .finally(() => setRunning(false));
  }, [awaitingCompletion, landing, onDone, projects]);
  const run = async () => {
    if (busy || runningRef.current) return;
    runningRef.current = true;
    registry.update(dataImportBatchPendingCount, (count) => count + 1);
    setRunning(true);
    setError(null);
    setMessage(null);
    let success = true;
    let firstProject = landing;
    const failures: string[] = [];
    try {
      const batch = environments.map((environment) => ({
        environment,
        importer: importers.current.get(environment.environmentId),
      }));
      for (const { environment, importer } of batch) {
        if (!mounted.current) return;
        if (!importer) {
          success = false;
          continue;
        }
        try {
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
      else if (onDone) setAwaitingCompletion(true);
      else setMessage("Import complete.");
    } finally {
      registry.update(dataImportBatchPendingCount, (count) => Math.max(0, count - 1));
      runningRef.current = false;
      setRunning(false);
    }
  };
  const skip = async () => {
    if (!onDone || busy || runningRef.current) return;
    setAwaitingCompletion(true);
  };
  return (
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
      onImport={() => void run()}
      onSkip={() => void skip()}
      message={message}
      error={error}
    >
      {environments.map((environment) => (
        <ImportComputer
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
          active={activeId === environment.environmentId}
          connected={environment.connection.phase === "connected"}
          busy={busy}
          onSummary={onSummary}
          ref={(importer) => {
            if (importer) importers.current.set(environment.environmentId, importer);
            else importers.current.delete(environment.environmentId);
          }}
        />
      ))}
    </ImportDataView>
  );
}
