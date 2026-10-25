import type {
  OrchestrationV2PendingBackgroundTask,
  ThreadWorkflowRunWatch,
} from "@t3tools/contracts";
import { workflowRunWatchTaskId } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

/** Compact only complete SHA tokens; stored names and run identities stay intact. */
export function formatWorkflowRunDisplayName(name: string): string {
  return name.replace(/\b([a-f\d]{8})[a-f\d]{32}\b/gi, "$1");
}

export function workflowRunReviewCoversBackgroundWork(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  runs: ReadonlyArray<ThreadWorkflowRunWatch>,
): boolean {
  const [task] = tasks;
  const reviewed = runs.filter((run) => run.review !== undefined);
  const [run] = reviewed;
  return (
    tasks.length === 1 &&
    task?.kind === "monitor" &&
    reviewed.length === 1 &&
    run !== undefined &&
    task.taskId === workflowRunWatchTaskId(run)
  );
}
