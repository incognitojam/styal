import { useEffect, useMemo, useRef, useState } from "react";
import {
  CommandId,
  type EnvironmentId,
  type ProjectId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";

import {
  partitionOnboardingProjects,
  onboardingProjectKey,
  resolveOnboardingLandingProject,
  resolveOnboardingProjectId,
} from "../../onboarding/projectImport.logic";
import { useProjectScans } from "../../onboarding/useProjectScans";
import { newProjectId } from "../../lib/utils";
import { agentSessionImport } from "../../state/agentSessions";
import { readProjects } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ImportOutcome } from "./types";

export interface HistoryImportProgress {
  readonly key: string;
  readonly title: string;
  readonly status: "queued" | "importing" | "complete" | "failed";
  readonly importedCount?: number;
  readonly skippedCount?: number;
}

/** The CLI history import pipeline used during first setup. */
export function useHistoryImport(environmentId: EnvironmentId, busy = false) {
  const [progress, setProgress] = useState<readonly HistoryImportProgress[] | null>(null);
  useEffect(() => {
    if (!busy) setProgress(null);
  }, [busy]);
  const environmentIds = useMemo(() => [environmentId], [environmentId]);
  const scans = useProjectScans(environmentIds);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string> | null>(null);
  const [importError, setImportError] = useState("");
  // Keep project creation attempts separate from completed history imports so both can retry.
  const importedProjectsRef = useRef(new Map<string, ScopedProjectRef>());
  const projectsWithImportedHistoryRef = useRef(new Map<string, ScopedProjectRef>());
  const lastImportSelectionRef = useRef<ReadonlyArray<string>>([]);
  const projectAttemptsRef = useRef(
    new Map<string, { readonly projectId: ProjectId; readonly commandId: CommandId }>(),
  );
  const importGenerationRef = useRef(0);

  // Ignore command completions after leaving the import step.
  useEffect(() => {
    importGenerationRef.current += 1;
    return () => {
      importGenerationRef.current += 1;
    };
  }, []);

  const { available: candidates, recent } = useMemo(
    () =>
      partitionOnboardingProjects(
        scans.flatMap((scan) =>
          (scan.data?.candidates ?? []).map((candidate) => ({
            ...candidate,
            environmentId: scan.environmentId,
            key: onboardingProjectKey(scan.environmentId, candidate.path),
          })),
        ),
      ),
    [scans],
  );
  const selectedKeys = selectedPaths ?? new Set(recent.map((item) => item.key));
  const selected = candidates.filter((candidate) => selectedKeys.has(candidate.key));

  const run = async (): Promise<ImportOutcome> => {
    const selection = selected;
    if (selection.length === 0) return { success: true };
    setImportError("");
    lastImportSelectionRef.current = selection.map((candidate) => candidate.key);
    const importGeneration = importGenerationRef.current;
    setProgress(
      selection.map((candidate) => ({
        key: candidate.key,
        title: candidate.title,
        status: "queued",
      })),
    );
    const updateProgress = (key: string, update: Partial<HistoryImportProgress>) => {
      if (importGeneration !== importGenerationRef.current) return;
      setProgress(
        (rows) => rows?.map((row) => (row.key === key ? { ...row, ...update } : row)) ?? null,
      );
    };
    const importedProjects = importedProjectsRef.current;
    const projectAttempts = projectAttemptsRef.current;
    // Interrupted imports are neither failures nor successes — the command was
    // superseded or the environment dropped — but they still didn't land, so
    // they must not read as "imported everything". Retries skip paths that
    // already landed this session (re-creating them would only trip the
    // duplicate-root invariant and read as a failure).
    // Successful rows are deselected after each run. An explicit re-selection
    // may import remaining history before finishing setup.
    for (const candidate of selection) importedProjects.delete(candidate.key);
    let importedProjectsCount = 0;
    let importedThreadCount = 0;
    let skippedThreadCount = 0;
    const refreshEnvironments = new Set<EnvironmentId>();
    for (const candidate of selection) {
      const { environmentId } = candidate;
      if (
        importGeneration !== importGenerationRef.current ||
        importedProjects !== importedProjectsRef.current
      ) {
        return { success: false };
      }
      updateProgress(candidate.key, { status: "importing" });
      try {
        let projectId = resolveOnboardingProjectId(readProjects(), environmentId, candidate);
        if (projectId === null) {
          let attempt = projectAttempts.get(candidate.key);
          if (attempt === undefined) {
            const nextProjectId = newProjectId();
            attempt = {
              projectId: nextProjectId,
              commandId: CommandId.make(`onboarding:project:create:${nextProjectId}`),
            };
            projectAttempts.set(candidate.key, attempt);
          }
          projectId = attempt.projectId;
          const result = await createProject({
            environmentId,
            input: {
              projectId,
              commandId: attempt.commandId,
              title: candidate.title,
              workspaceRoot: candidate.path,
              createWorkspaceRootIfMissing: false,
              defaultModelSelection: null,
            },
          });
          if (
            importGeneration !== importGenerationRef.current ||
            importedProjects !== importedProjectsRef.current
          ) {
            return { success: false };
          }
          if (result._tag !== "Success") {
            updateProgress(candidate.key, { status: "failed" });
            if (!isAtomCommandInterrupted(result)) {
              projectAttempts.delete(candidate.key);
              refreshEnvironments.add(environmentId);
            }
            continue;
          }
        }

        const threadImportResult = await importThreads({
          environmentId,
          input: { projectId, expectedWorkspaceRoot: candidate.path },
        });
        if (
          importGeneration !== importGenerationRef.current ||
          importedProjects !== importedProjectsRef.current
        ) {
          return { success: false };
        }
        if (threadImportResult._tag === "Success") {
          updateProgress(candidate.key, {
            status: threadImportResult.value.skippedCount === 0 ? "complete" : "failed",
            importedCount: threadImportResult.value.importedCount,
            skippedCount: threadImportResult.value.skippedCount,
          });
          importedThreadCount += threadImportResult.value.importedCount;
          skippedThreadCount += threadImportResult.value.skippedCount;
          if (threadImportResult.value.importedCount > 0) {
            projectsWithImportedHistoryRef.current.set(
              candidate.key,
              scopeProjectRef(environmentId, projectId),
            );
          }
          if (threadImportResult.value.skippedCount === 0) {
            importedProjectsCount += 1;
            importedProjects.set(candidate.key, scopeProjectRef(environmentId, projectId));
          }
        } else {
          updateProgress(candidate.key, { status: "failed" });
          if (!isAtomCommandInterrupted(threadImportResult)) {
            projectAttempts.delete(candidate.key);
            refreshEnvironments.add(environmentId);
          }
        }
      } catch {
        updateProgress(candidate.key, { status: "failed" });
        refreshEnvironments.add(environmentId);
      }
    }
    for (const scan of scans) {
      if (refreshEnvironments.has(scan.environmentId)) scan.refresh();
    }
    setSelectedPaths(
      new Set(
        selection
          .filter((candidate) => !importedProjects.has(candidate.key))
          .map((candidate) => candidate.key),
      ),
    );
    const projectRef = resolveOnboardingLandingProject(
      lastImportSelectionRef.current,
      projectsWithImportedHistoryRef.current,
      importedProjectsRef.current,
    );
    if (importedProjectsCount < selection.length) {
      if (importedThreadCount > 0 && skippedThreadCount > 0) {
        setImportError(
          `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}. ${skippedThreadCount} ${skippedThreadCount === 1 ? "thread" : "threads"} could not be imported.`,
        );
      } else if (skippedThreadCount > 0) {
        setImportError(
          `${skippedThreadCount} ${skippedThreadCount === 1 ? "thread could" : "threads could"} not be imported.`,
        );
      } else if (importedThreadCount > 0) {
        setImportError(
          `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}. Some thread history could not be imported.`,
        );
      } else {
        setImportError("Could not import thread history.");
      }
      return { success: false, projectRef };
    }
    setSelectedPaths(new Set());
    return { success: true, projectRef };
  };

  return {
    progress,
    scan: scans[0]!,
    candidates,
    selected,
    error: importError,
    run,
    setSelected: (keys: ReadonlySet<string>) => setSelectedPaths(keys),
  };
}
