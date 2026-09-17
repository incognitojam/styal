import { useEffect, useImperativeHandle, type Ref } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ImportPreferencesView, ImportSourceView } from "./ImportDataView";
import { useHistoryImport } from "./useHistoryImport";
import { LegacyImportProgressView } from "./LegacyImportProgressView";
import { useLegacyImport } from "./useLegacyImport";
import type { ComputerImporter, ComputerImportSummary, LegacyImportStage } from "./types";

const UNAVAILABLE = {
  "current-database": "This computer already runs on this T3 Code data.",
  "unsupported-database":
    "This T3 Code database format is not supported. Update that installation, then rescan.",
  "unreadable-database": "Could not read the T3 Code database. Check its permissions, then rescan.",
};

interface ImportComputerProps {
  environmentId: EnvironmentId;
  label: string;
  active: boolean;
  connected: boolean;
  busy: boolean;
  setup: boolean;
  importing: boolean;
  onSummary: (id: EnvironmentId, summary: ComputerImportSummary) => void;
  ref: Ref<ComputerImporter>;
}

/** Mounted once per computer so changing computers or steps preserves selections. */
export function LegacyImportComputer({
  environmentId,
  label,
  active,
  connected,
  busy,
  onSummary,
  ref,
  stage,
  setup,
  importing,
}: ImportComputerProps & { stage: LegacyImportStage }) {
  const legacy = useLegacyImport(environmentId, busy);
  const selectedLegacyIds = new Set(legacy.selected.map((project) => project.projectId));
  const projects = legacy.selected.length;
  const threads = legacy.selected.reduce((total, project) => total + project.threadCount, 0);
  const preferences = legacy.selectedPreferences ? 1 : 0;
  useEffect(
    () => onSummary(environmentId, { projects, threads, preferences }),
    [environmentId, onSummary, projects, threads, preferences],
  );
  useImperativeHandle(ref, () => ({
    run: async () => {
      if (!connected && (projects > 0 || preferences > 0))
        throw new Error(`${label} is not connected.`);
      return legacy.run();
    },
  }));
  const available = legacy.preview?.status === "available" ? legacy.preview : null;
  const preferencePreview = available?.preferences;
  return (
    <div hidden={!active && !importing} className="space-y-5" aria-label={label}>
      {importing ? (
        <LegacyImportProgressView
          label={label}
          progress={legacy.progress}
          preview={legacy.query.data}
          selected={legacy.selected}
          preferences={legacy.selectedPreferences}
          pending={legacy.query.isPending}
          error={legacy.query.error}
        />
      ) : (
        <>
          {!connected ? (
            <p role="status" className="text-sm text-muted-foreground">
              Waiting for {label} to connect.
            </p>
          ) : null}
          {!setup || stage === "projects" ? (
            <ImportSourceView
              disabled={busy || !connected}
              source={{
                title:
                  available?.sourceKind === "t3-code-yngatech" ? "T3 Code (yngatech)" : "T3 Code",
                projects: legacy.projects.map((project) => ({
                  id: project.projectId,
                  legacyFavicon: { environmentId, projectId: project.projectId },
                  title: project.title.trim() || "Untitled project",
                  path: project.workspaceRoot,
                  threads: project.threadCount,
                  selected: selectedLegacyIds.has(project.projectId),
                  detail:
                    [
                      project.isExistingProject ? "Already in styal" : null,
                      project.contextRepairCount > 0
                        ? `${project.contextRepairCount} ${project.contextRepairCount === 1 ? "repair" : "repairs"}`
                        : null,
                      project.scriptCount > 0
                        ? `${project.scriptCount} ${project.scriptCount === 1 ? "script" : "scripts"}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || undefined,
                })),
                pending: legacy.query.isPending && legacy.preview === null,
                error: legacy.error ?? legacy.query.error,
                message:
                  legacy.preview?.status === "not-found"
                    ? "No T3 Code data found in the default T3 home."
                    : legacy.preview?.status === "unavailable"
                      ? UNAVAILABLE[legacy.preview.reason]
                      : available && available.projects.length === 0
                        ? "No T3 Code projects found."
                        : undefined,
                notice: legacy.notice,
                refresh: legacy.query.refresh,
                select: legacy.setSelection,
              }}
            />
          ) : null}
          {!setup || stage === "preferences" ? (
            available ? (
              <ImportPreferencesView
                disabled={busy || !connected}
                preferences={{
                  changes: legacy.changes,
                  selected: legacy.selectedPreferences,
                  select: legacy.setIncludeSettings,
                  error: legacy.preferencesError,
                  message:
                    preferencePreview?.status === "available"
                      ? legacy.changes.length === 0
                        ? "Preferences already match"
                        : undefined
                      : preferencePreview?.status === "unreadable"
                        ? "T3 Code preferences could not be read."
                        : "No T3 Code preferences found.",
                }}
              />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {legacy.query.isPending
                  ? "Checking T3 Code preferences…"
                  : (legacy.query.error ?? "No T3 Code preferences available.")}
              </p>
            )
          ) : null}
        </>
      )}
    </div>
  );
}

/** CLI discovery belongs to first setup; Settings never mounts this component. */
export function HistoryImportComputer({
  environmentId,
  label,
  active,
  connected,
  busy,
  onSummary,
  ref,
}: ImportComputerProps) {
  const history = useHistoryImport(environmentId);
  const selectedHistoryKeys = new Set(history.selected.map((project) => project.key));
  const projects = history.selected.length;
  const threads = history.selected.reduce((total, project) => total + project.threadCount, 0);
  useEffect(
    () => onSummary(environmentId, { projects, threads, preferences: 0 }),
    [environmentId, onSummary, projects, threads],
  );
  useImperativeHandle(ref, () => ({
    run: async () => {
      if (!connected && projects > 0) throw new Error(`${label} is not connected.`);
      return history.run();
    },
  }));
  return (
    <div hidden={!active} className="space-y-5" aria-label={label}>
      {!connected ? (
        <p role="status" className="text-sm text-muted-foreground">
          Waiting for {label} to connect.
        </p>
      ) : null}
      <ImportSourceView
        disabled={busy || !connected}
        source={{
          title: "Claude Code / Codex",
          projects: history.candidates.map((project) => ({
            id: project.key,
            title: project.title,
            providers: project.sources,
            path: project.path,
            threads: project.threadCount,
            selected: selectedHistoryKeys.has(project.key),
          })),
          pending: history.scan.isPending && history.scan.data === null,
          error: history.error || history.scan.error,
          message:
            history.scan.data && history.candidates.length === 0
              ? "No Claude Code or Codex projects found."
              : undefined,
          notice: history.scan.data?.truncated
            ? "Scan limit reached. Some projects or conversations may be missing."
            : undefined,
          refresh: history.scan.refresh,
          select: history.setSelected,
        }}
      />
    </div>
  );
}
