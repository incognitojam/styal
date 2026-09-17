import { LoaderCircleIcon } from "lucide-react";
import type { LegacyImportPreview, LegacyImportProjectPreview } from "@t3tools/contracts";
import type { LegacyImportProgress } from "./useLegacyImport";
import { ImportProgressView } from "./ImportProgressView";

/** Preview counts describe remaining work; only a command receipt confirms completion. */
export function LegacyImportProgressView({
  label,
  progress,
  preview,
  selected,
  preferences,
  pending,
  error,
}: {
  label: string;
  progress: LegacyImportProgress | null;
  preview: LegacyImportPreview | null;
  selected: readonly LegacyImportProjectPreview[];
  preferences: boolean;
  pending: boolean;
  error: string | null;
}) {
  const projects = progress?.projects ?? selected;
  const preferenceStatus = progress?.preferences ?? (preferences ? "queued" : null);
  if (projects.length === 0 && preferenceStatus === null) return null;
  const remaining = preview?.status === "available" ? preview.projects : null;
  const remainingById = new Map(remaining?.map((project) => [project.projectId, project]));
  const resultById = new Map(
    progress?.result?.projects.map((project) => [project.sourceProjectId, project]),
  );
  const rows = projects.map((project) => {
    const result = resultById.get(project.projectId);
    const complete = result !== undefined && result.status !== "failed";
    const failed = result?.status === "failed" || progress?.projectsError !== undefined;
    const current = remainingById.get(project.projectId);
    const threads = remaining === null ? project.threadCount : (current?.threadCount ?? 0);
    const repairs =
      remaining === null ? project.contextRepairCount : (current?.contextRepairCount ?? 0);
    const status = complete
      ? "Complete"
      : failed
        ? "Could not import"
        : !progress
          ? "Queued"
          : threads > 0
            ? `${threads.toLocaleString()} ${threads === 1 ? "thread" : "threads"} remaining`
            : repairs > 0
              ? `${repairs.toLocaleString()} ${repairs === 1 ? "repair" : "repairs"} remaining`
              : "Finishing…";
    return {
      id: `project:${project.projectId}`,
      title: project.title.trim() || "Untitled project",
      status,
      complete,
      failed,
    };
  });
  if (preferenceStatus !== null)
    rows.push({
      id: "preferences",
      title: "Preferences",
      status:
        preferenceStatus === "queued"
          ? "Queued"
          : preferenceStatus === "importing"
            ? "Importing…"
            : preferenceStatus === "complete"
              ? "Complete"
              : "Could not import",
      complete: preferenceStatus === "complete",
      failed: preferenceStatus === "failed",
    });
  return (
    <ImportProgressView label={label} rows={rows}>
      {progress?.phase === "projects" ? (
        <p
          role="status"
          className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5 text-xs text-muted-foreground"
        >
          <LoaderCircleIcon
            className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          {error
            ? "Progress refresh unavailable. Import is still running."
            : pending
              ? "Refreshing progress…"
              : "Importing · Updates every 30 seconds"}
        </p>
      ) : null}
    </ImportProgressView>
  );
}
