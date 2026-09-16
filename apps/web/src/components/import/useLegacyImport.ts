import { useEffect, useMemo, useRef, useState } from "react";
import {
  ProjectId,
  type EnvironmentId,
  type LegacyImportPreview,
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
  const [includeSettings, setIncludeSettings] = useState(false);
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

  const run = async (): Promise<ImportOutcome> => {
    setError(null);
    setPreferencesError(null);
    setNotice(undefined);
    let success = true;
    let projectRef: ScopedProjectRef | undefined;
    // Keep the existing independent requests: a project failure cannot apply preferences implicitly.
    if (selected.length > 0) {
      const result = await command({
        environmentId,
        input: { projectIds: selected.map((p) => p.projectId), includeSettings: false },
      });
      if (result._tag === "Failure") {
        setError(
          isAtomCommandInterrupted(result)
            ? "Import interrupted. Retry when this computer reconnects."
            : importErrorMessage(squashAtomCommandFailure(result)),
        );
        success = false;
      } else {
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
    if (selectedPreferences) {
      const result = await command({
        environmentId,
        input: { projectIds: [], includeSettings: true },
      });
      if (result._tag === "Failure") {
        setPreferencesError(
          isAtomCommandInterrupted(result)
            ? "Import interrupted. Retry when this computer reconnects."
            : importErrorMessage(squashAtomCommandFailure(result)),
        );
        success = false;
      } else if (result.value.settings?.status !== "imported") {
        setPreferencesError(
          result.value.settings?.detail ?? "Preferences could not be imported. Rescan and retry.",
        );
        success = false;
      } else {
        setIncludeSettings(false);
        query.refresh();
      }
    }
    return { success, projectRef };
  };

  return {
    query,
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
