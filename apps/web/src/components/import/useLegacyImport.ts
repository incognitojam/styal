import { useEffect, useMemo, useRef, useState } from "react";
import {
  ProjectId,
  type EnvironmentId,
  type LegacyImportPreview,
  type LegacyImportProjectPreview,
  type LegacyImportResult,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { importLegacyData, legacyImportPreview } from "../../state/dataImport";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildPreferenceComparisonRows,
  legacyImportPreviewsEqual,
  selectLegacyImportPreferences,
} from "../settings/DataImportSettings.logic";
import type { ImportOutcome } from "./types";

export function importErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The selected data could not be imported.";
}

export interface LegacyImportProgress {
  readonly projects: readonly LegacyImportProjectPreview[];
  readonly phase: "projects" | "preferences" | "done";
  readonly result?: LegacyImportResult;
  readonly projectsError?: string;
  readonly preferences: "queued" | "importing" | "complete" | "failed" | null;
}

export function useLegacyImport(environmentId: EnvironmentId, busy: boolean) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const query = useEnvironmentQuery(legacyImportPreview({ environmentId, input: {} }));
  const current = useEnvironmentSettings(environmentId, selectLegacyImportPreferences);
  const command = useAtomCommand(importLegacyData, {
    label: "import T3 Code data",
    reportFailure: false,
  });
  const retained = useRef<LegacyImportPreview | null>(null);
  // Keep the review stable during a run and across identical polling responses.
  if (!busy && !legacyImportPreviewsEqual(retained.current, query.data))
    retained.current = query.data;
  const preview = retained.current;
  const available = preview?.status === "available" ? preview : null;
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null);
  const projects = available?.projects ?? [];
  const selected = projects.filter(
    (project) => selection === null || selection.has(project.projectId),
  );
  const [includeSettings, setIncludeSettings] = useState(true);
  const preferences = available?.preferences;
  const changes = useMemo(
    () =>
      preferences?.status === "available"
        ? buildPreferenceComparisonRows(preferences.values, current).filter((row) => row.changed)
        : [],
    [preferences, current],
  );
  const selectedPreferences = includeSettings && changes.length > 0;
  const [error, setError] = useState<string | null>(null);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>();
  const [progress, setProgress] = useState<LegacyImportProgress | null>(null);
  useEffect(() => {
    if (!busy) setProgress(null);
  }, [busy]);

  const run = async ({
    includeProjects = true,
    includePreferences = true,
  } = {}): Promise<ImportOutcome> => {
    const selectedProjects = includeProjects ? selected : [];
    const importPreferences = includePreferences && selectedPreferences;
    setProgress({
      projects: selectedProjects,
      phase: selectedProjects.length > 0 ? "projects" : "preferences",
      preferences: importPreferences ? "queued" : null,
    });
    setError(null);
    setPreferencesError(null);
    setNotice(undefined);
    let success = true;
    let projectRef: ScopedProjectRef | undefined;
    // Keep the existing independent requests: a project failure cannot apply preferences implicitly.
    if (selectedProjects.length > 0) {
      const result = await command({
        environmentId,
        input: { projectIds: selectedProjects.map((p) => p.projectId), includeSettings: false },
      });
      if (result._tag === "Failure") {
        const message = isAtomCommandInterrupted(result)
          ? "Import interrupted. Retry when this computer reconnects."
          : importErrorMessage(squashAtomCommandFailure(result));
        setError(message);
        setProgress((current) => current && { ...current, projectsError: message });
        success = false;
      } else {
        setProgress((current) => current && { ...current, result: result.value });
        const firstProject = result.value.projects.find((project) => project.status !== "failed");
        if (firstProject)
          projectRef = scopeProjectRef(environmentId, ProjectId.make(firstProject.targetProjectId));
        const failed = result.value.projects.filter((project) => project.status === "failed");
        setSelection(new Set(failed.map((project) => project.sourceProjectId)));
        success = failed.length === 0;
        if (failed.length)
          setError(
            failed
              .map((project) => `${project.title}: ${project.detail ?? "Could not import"}`)
              .join(" · "),
          );
        const parts = [
          `${result.value.importedProjectCount} projects and ${result.value.importedThreadCount} threads imported`,
        ];
        if (result.value.repairedThreadCount)
          parts.push(`${result.value.repairedThreadCount} threads repaired`);
        if (result.value.skippedAttachmentCount)
          parts.push(`${result.value.skippedAttachmentCount} attachments unavailable`);
        setNotice(parts.join(" · "));
        query.refresh();
      }
    }
    if (!mounted.current) return { success: false };
    if (importPreferences) {
      setProgress(
        (current) => current && { ...current, phase: "preferences", preferences: "importing" },
      );
      const result = await command({
        environmentId,
        input: { projectIds: [], includeSettings: true },
      });
      if (result._tag === "Failure") {
        setProgress((current) => current && { ...current, preferences: "failed" });
        setPreferencesError(
          isAtomCommandInterrupted(result)
            ? "Import interrupted. Retry when this computer reconnects."
            : importErrorMessage(squashAtomCommandFailure(result)),
        );
        success = false;
      } else if (result.value.settings?.status !== "imported") {
        setProgress((current) => current && { ...current, preferences: "failed" });
        setPreferencesError(
          result.value.settings?.detail ?? "Preferences could not be imported. Rescan and retry.",
        );
        success = false;
      } else {
        setProgress((current) => current && { ...current, preferences: "complete" });
        setIncludeSettings(false);
        query.refresh();
      }
    }
    setProgress((current) => current && { ...current, phase: "done" });
    return { success, projectRef };
  };

  return {
    query,
    progress,
    preview,
    projects,
    selected,
    setSelection,
    changes,
    selectedPreferences,
    setIncludeSettings,
    error,
    preferencesError,
    notice,
    run,
  };
}
