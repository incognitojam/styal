import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { dataImportBatchPendingCount, legacyImportPendingCount } from "../../state/dataImport";
import { useEnvironments } from "../../state/environments";
import { runImportBatch } from "../import/DataImportPanel";
import { LegacyImportComputer } from "../import/ImportComputer";
import { plural } from "../import/ImportDataView";
import type { ComputerImporter, ComputerImportSummary } from "../import/types";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { RowIcon, WelcomeSection } from "./welcomeLayout";

export const T3_DISCOVERING_MESSAGE = "Checking for T3 Code…";

/**
 * Migration from a T3 Code install on the computers being set up. Each computer keeps its own
 * project and preference choices, so leaving one out does not discard the others. Start imports
 * each computer's projects, then its preferences, as separate requests.
 */
export function useWelcomeT3Import(environmentIds: ReadonlyArray<EnvironmentId>) {
  const registry = useContext(RegistryContext);
  const importers = useRef(new Map<EnvironmentId, ComputerImporter>());
  const [summaries, setSummaries] = useState<ReadonlyMap<EnvironmentId, ComputerImportSummary>>(
    new Map(),
  );
  const onSummary = (id: EnvironmentId, summary: ComputerImportSummary) =>
    setSummaries((current) => new Map(current).set(id, summary));
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A retry that only sends preferences returns no project, so keep the first one imported.
  const landing = useRef<ScopedProjectRef | undefined>(undefined);
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- marks a running import batch stale when the page unmounts
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // An import started in Settings, or one still finishing, keeps the page from starting another.
  const pending =
    useAtomValue(legacyImportPendingCount) + useAtomValue(dataImportBatchPendingCount);
  const current = environmentIds.flatMap((id) => {
    const summary = summaries.get(id);
    return summary ? [summary] : [];
  });
  const projectsAvailable = current.reduce(
    (total, each) => total + (each.projectsAvailable ?? 0),
    0,
  );
  const projectsSelected = current.reduce((total, each) => total + each.projects, 0);
  const threadsSelected = current.reduce((total, each) => total + each.threads, 0);
  const preferenceComputers = current.filter((each) => (each.preferenceChanges ?? 0) > 0);
  const preferencesSelected = preferenceComputers.filter((each) => each.preferencesSelected).length;
  // Start waits for this, so a slow computer's T3 Code data is not skipped before it is shown.
  const discovering = current.some((each) => each.previewPending === true);
  const forEachImporter = (apply: (importer: ComputerImporter) => void) => {
    for (const id of environmentIds) {
      const importer = importers.current.get(id);
      if (importer) apply(importer);
    }
  };

  /** False when something failed; failed work stays selected so Start can retry it. */
  const run = async (
    labelOf: (id: EnvironmentId) => string,
  ): Promise<{ readonly success: boolean; readonly projectRef?: ScopedProjectRef | undefined }> => {
    if (projectsSelected === 0 && preferencesSelected === 0) {
      return { success: true, projectRef: landing.current };
    }
    setRunning(true);
    setError(null);
    registry.update(dataImportBatchPendingCount, (count) => count + 1);
    const outcome = await runImportBatch(
      environmentIds.map((id) => ({
        environment: { label: labelOf(id) },
        importer: importers.current.get(id),
        options: { includePreferences: true },
      })),
      mounted,
      setProgress,
    ).finally(() => {
      registry.update(dataImportBatchPendingCount, (count) => Math.max(0, count - 1));
    });
    if (!mounted.current || outcome === null) return { success: false };
    if (landing.current === undefined) landing.current = outcome.firstProject;
    setRunning(false);
    setProgress(null);
    if (!outcome.success) {
      setError(
        `Some T3 Code data could not be imported${outcome.failures.length > 0 ? ` on ${outcome.failures.join(", ")}` : ""}. Start again to retry what is still selected.`,
      );
    }
    return { success: outcome.success, projectRef: landing.current };
  };

  return {
    importers,
    onSummary,
    found: projectsAvailable > 0 || preferenceComputers.length > 0,
    discovering,
    projectsAvailable,
    projectsSelected,
    threadsSelected,
    preferenceComputers: preferenceComputers.length,
    preferenceChanges: preferenceComputers.reduce(
      (total, each) => total + (each.preferenceChanges ?? 0),
      0,
    ),
    preferencesSelected,
    selectAllProjects: (selected: boolean) =>
      forEachImporter((importer) => importer.selectAllProjects?.(selected)),
    selectPreferences: (selected: boolean) =>
      forEachImporter((importer) => importer.selectPreferences?.(selected)),
    running,
    progress,
    error,
    pending: pending > 0,
    run,
  };
}

export function WelcomeT3ImportSection({
  t3,
  environmentIds,
  busy,
}: {
  readonly t3: ReturnType<typeof useWelcomeT3Import>;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly busy: boolean;
}) {
  const { environments } = useEnvironments();
  const [reviewing, setReviewing] = useState(false);
  const several = environmentIds.length > 1;
  // A computer that leaves the selection stays mounted, so selecting it again keeps its choices.
  const [knownIds, setKnownIds] = useState(environmentIds);
  const added = environmentIds.filter((id) => !knownIds.includes(id));
  if (added.length > 0) setKnownIds([...knownIds, ...added]);
  const reviewButton = (
    <Button
      variant="ghost-muted"
      size="xs"
      aria-expanded={reviewing}
      onClick={() => setReviewing((open) => !open)}
    >
      {reviewing ? "Hide" : "Review"}
      <ChevronDownIcon className={cn("size-3.5", reviewing && "rotate-180")} />
    </Button>
  );
  const computers = knownIds.map((id) => {
    const environment = environments.find((each) => each.environmentId === id);
    const label = environment?.label ?? "this computer";
    const selected = environmentIds.includes(id);
    const labelled = selected && several && reviewing && !t3.running;
    return (
      <div key={id} hidden={!selected} className={cn(labelled && "space-y-2")}>
        {labelled ? <p className="text-xs text-muted-foreground">{label}</p> : null}
        <LegacyImportComputer
          environmentId={id}
          label={label}
          active={selected && reviewing}
          connected={environment?.connection.phase === "connected"}
          busy={busy}
          setup={false}
          stage="projects"
          includeProjects
          importing={selected && t3.running}
          onSummary={t3.onSummary}
          ref={(importer) => {
            if (importer) t3.importers.current.set(id, importer);
            else t3.importers.current.delete(id);
          }}
        />
      </div>
    );
  });
  const projectsPartial = t3.projectsSelected > 0 && t3.projectsSelected < t3.projectsAvailable;
  const preferencesPartial =
    t3.preferencesSelected > 0 && t3.preferencesSelected < t3.preferenceComputers;
  // The computers stay mounted while nothing is found, so their scans and choices persist.
  return (
    <div hidden={!t3.found}>
      <WelcomeSection title="T3 Code">
        {t3.projectsAvailable > 0 ? (
          <div className="flex min-h-10 items-center gap-3 py-1">
            <label className="flex min-w-0 flex-1 items-center gap-3">
              <RowIcon>
                <Checkbox
                  checked={t3.projectsSelected > 0}
                  indeterminate={projectsPartial}
                  disabled={busy}
                  onCheckedChange={(checked) => t3.selectAllProjects(checked)}
                />
              </RowIcon>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">
                  {t3.projectsSelected > 0
                    ? `Import ${plural(t3.projectsSelected, "project")} from T3 Code`
                    : "Import projects from T3 Code"}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t3.projectsSelected > 0
                    ? `${plural(t3.threadsSelected, "thread")} with their history and attachments`
                    : "Projects, threads and attachments from your T3 Code install"}
                </span>
              </span>
            </label>
            {reviewButton}
          </div>
        ) : null}
        {t3.preferenceComputers > 0 ? (
          <div className="flex min-h-10 items-center gap-3 py-1">
            <label className="flex min-w-0 flex-1 items-center gap-3">
              <RowIcon>
                <Checkbox
                  checked={t3.preferencesSelected > 0}
                  indeterminate={preferencesPartial}
                  disabled={busy}
                  onCheckedChange={(checked) => t3.selectPreferences(checked)}
                />
              </RowIcon>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">
                  Bring over T3 Code preferences
                </span>
                <span className="block text-xs text-muted-foreground">
                  {several
                    ? `Different on ${plural(t3.preferenceComputers, "computer")}`
                    : `${t3.preferenceChanges} ${t3.preferenceChanges === 1 ? "setting differs" : "settings differ"} from styal`}
                </span>
              </span>
            </label>
            {t3.projectsAvailable > 0 ? null : reviewButton}
          </div>
        ) : null}
        <div className={cn("space-y-4", (reviewing || t3.running) && "pt-2 pb-1")}>{computers}</div>
        {t3.progress !== null ? (
          <p className="pt-1 pl-8 text-xs text-muted-foreground" role="status">
            {t3.progress}
          </p>
        ) : null}
        {t3.error !== null ? (
          <p className="pt-1 pl-8 text-sm text-destructive" role="alert">
            {t3.error}
          </p>
        ) : null}
      </WelcomeSection>
    </div>
  );
}
