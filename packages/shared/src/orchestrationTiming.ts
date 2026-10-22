import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function deriveSubagentElapsedMs(
  agent: {
    readonly status: OrchestrationV2Subagent["status"];
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  },
  nowMs: number,
): number | null {
  if (agent.startedAt === null) return null;
  const end = isOrchestrationV2WorkActive(agent.status)
    ? nowMs
    : agent.completedAt === null
      ? null
      : Date.parse(agent.completedAt);
  if (end === null) return null;
  const start = Date.parse(agent.startedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

type LatestRunTiming = {
  readonly runId: string | null;
  readonly requestedAt?: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
};

type RuntimeActivityState = {
  readonly orchestrationStatus: string;
  readonly activeRunId?: string | null;
};

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  // Each unit is chosen after rounding, so 59.6s reads "1m" rather than "60s".
  if (Math.round(durationMs) < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function isLatestRunSettled(
  latestRun: LatestRunTiming | null,
  runtime: RuntimeActivityState | null,
): boolean {
  if (!latestRun) return false;
  if (!latestRun.completedAt) return false;
  if (!runtime) return true;
  if (runtime.orchestrationStatus === "running") return false;
  return true;
}

/**
 * The projector only stamps `startedAt` in the same update that moves the
 * session to "running", so while the provider spins up (session "starting") a
 * requested turn has no `startedAt` at all — and returning null there blinks
 * the indicator out for the whole spin-up.
 */
export function deriveActiveWorkStartedAt(
  latestRun: LatestRunTiming | null,
  runtime: RuntimeActivityState | null,
  sendStartedAt: string | null,
): string | null {
  if (runtime?.activeRunId && runtime.activeRunId !== latestRun?.runId) {
    return sendStartedAt;
  }
  if (!isLatestRunSettled(latestRun, runtime)) {
    return latestRun?.startedAt ?? latestRun?.requestedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

/**
 * When a run's recorded work ended: its last provider work or assistant
 * message update. Restart recovery stamps the interrupted run cancelled at
 * startup, so that terminal time includes the outage and is ignored.
 */
/**
 * A thread structure drops `updatedAt` from streamed assistant and reasoning
 * items; their run's assistant message still records when the text last moved.
 */
export type RecordedWorkTurnItem = Pick<
  OrchestrationV2TurnItem,
  "runId" | "type" | "completedAt"
> & {
  readonly updatedAt?: OrchestrationV2TurnItem["updatedAt"];
};

export function orchestrationV2RunRecordedWorkEndMs(
  run: Pick<OrchestrationV2Run, "id" | "requestedAt" | "completedAt" | "status">,
  projection: {
    readonly turnItems: ReadonlyArray<RecordedWorkTurnItem>;
    readonly messages?: ReadonlyArray<
      Pick<OrchestrationV2ConversationMessage, "runId" | "role" | "updatedAt">
    >;
  },
): number {
  let end = DateTime.toEpochMillis(run.requestedAt);
  for (const item of projection.turnItems) {
    if (
      item.runId !== run.id ||
      item.type === "user_message" ||
      item.type === "notification" ||
      item.type === "error" ||
      item.type === "system_notice"
    )
      continue;
    const recordedAt = item.completedAt ?? item.updatedAt;
    if (recordedAt !== undefined) end = Math.max(end, DateTime.toEpochMillis(recordedAt));
  }
  for (const message of projection.messages ?? []) {
    if (message.runId === run.id && message.role === "assistant") {
      end = Math.max(end, DateTime.toEpochMillis(message.updatedAt));
    }
  }
  if ((run.status === "completed" || run.status === "failed") && run.completedAt !== null) {
    end = Math.max(end, DateTime.toEpochMillis(run.completedAt));
  }
  return end;
}
