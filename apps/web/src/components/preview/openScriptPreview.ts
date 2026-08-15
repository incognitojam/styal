import type {
  OrchestrationThreadActivity,
  ProjectScript,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { openPreviewSession } from "./openPreviewSession";

/**
 * The URL an action's preview should open at, or `null` when the action opted
 * out or configured something we cannot preview.
 *
 * Normalisation matches the browser URL bar, so `localhost:5173` works as well
 * as a fully-qualified URL. A malformed `previewUrl` resolves to `null` rather
 * than throwing: by the time this runs the command is already on its way to
 * the terminal, and a bad preview URL must not read as a script failure.
 */
export function resolveScriptPreviewUrl(
  script: Pick<ProjectScript, "previewUrl" | "autoOpenPreview">,
): string | null {
  if (script.previewUrl === undefined || script.autoOpenPreview !== true) return null;
  try {
    return normalizePreviewUrl(script.previewUrl);
  } catch {
    return null;
  }
}

/**
 * Open the preview panel at an action's `previewUrl` now that the action has
 * started. Callers fire and forget: an unreachable target must never delay the
 * terminal the command was written to.
 */
export async function openScriptPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly script: Pick<ProjectScript, "previewUrl" | "autoOpenPreview">;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<void> {
  const url = resolveScriptPreviewUrl(input.script);
  // The preview panel only exists behind the desktop bridge, which is what the
  // "desktop only" badge on these actions is telling the user.
  if (url === null || !isPreviewSupportedInRuntime()) return;

  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    url,
  });
  if (result._tag === "Failure") return;
  recordVisitForThread(input.threadRef, url);
  useRightPanelStore.getState().openBrowser(input.threadRef, result.value.tabId);
}

export interface StartedSetupScript {
  readonly activityId: string;
  readonly scriptId: string;
}

function setupRunPayload(payload: unknown): { runId: string; scriptId: string | null } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.runId !== "string" || record.runId.length === 0) return null;
  return {
    runId: record.runId,
    scriptId: typeof record.scriptId === "string" ? record.scriptId : null,
  };
}

/**
 * `setup-script.started` activities for runs that have not finished yet.
 *
 * `runOnWorktreeCreate` scripts never reach `runProjectScript` — the server
 * runs them — so this activity is the client's only signal that one started.
 * Thread activity is replayed on reconnect and refetch, so finished runs are
 * dropped here: only a run still in flight is worth opening a preview for.
 * Mirrors `deriveUnfinishedSetupRuns` on the server.
 */
export function unfinishedSetupScriptStarts(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<StartedSetupScript> {
  const started = new Map<string, StartedSetupScript>();
  for (const activity of activities) {
    if (!activity.kind.startsWith("setup-script.")) continue;
    const payload = setupRunPayload(activity.payload);
    if (payload === null) continue;
    if (activity.kind === "setup-script.started") {
      if (payload.scriptId !== null) {
        started.set(payload.runId, { activityId: activity.id, scriptId: payload.scriptId });
      }
      continue;
    }
    if (activity.kind === "setup-script.requested") continue;
    started.delete(payload.runId);
  }
  return [...started.values()];
}
