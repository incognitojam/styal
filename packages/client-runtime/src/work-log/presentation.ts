import { styalToolHeading } from "@t3tools/shared/styalToolWording";
import {
  isReportFindingsToolName,
  readReviewFindingsReport,
  type ReviewFindingsReport,
} from "@t3tools/shared/reviewFindings";
import {
  deriveToolRowPresentation,
  memoryFileReadPath,
  memoryFileToolKind,
  memoryFileToolPath,
} from "@t3tools/shared/toolRowPresentation";

import {
  isOrchestrationV2WorkActive,
  isToolLifecycleItemType,
  type AssetResource,
  type RuntimeItemStatus,
  type ToolActivitySource,
  type ToolActivitySurface,
  type ToolActivityIcon,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2ConversationMessage,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  resolveT3McpToolDefinition,
  type T3McpToolDefinition,
  type T3McpToolSummaryAction,
} from "@t3tools/shared/t3McpToolPresentation";
import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { formatTokens } from "@t3tools/shared/usageFormat";
import {
  orchestrationV2RunRecordedWorkEndMs,
  type RecordedWorkTurnItem,
} from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";
import { classifyToolActivity } from "@t3tools/shared/toolActivity";
import { toolOutputIndicatesFailure } from "@t3tools/shared/toolOutput";

import {
  summarizeT3ToolCalls,
  t3ToolResultIndicatesFailure,
  type T3ToolSummaryCall,
} from "@t3tools/client-runtime/t3ToolSummary";

/**
 * Whether a restart continuation resumes the response of the run it continues.
 * Only a response the restart cut short resumes. A source that had already
 * settled keeps its own final answer; the continuation, prompted with the note
 * about its cancelled background work, starts a new response.
 */
export function restartContinuationResumesResponse(
  source: { readonly status?: OrchestrationV2Run["status"] | undefined } | undefined,
): boolean {
  return source?.status !== "completed" && source?.status !== "waiting";
}

/**
 * Time this response, carrying recorded work across linked recovery runs and
 * excluding server outages. The task-wide `workStartedAt` also includes earlier
 * responses and background waits, so it is not a conversation header clock.
 */
export function continuedResponseWorkStartedAt(input: {
  readonly startedAt: string | null;
  readonly runId: RunId | null;
  readonly projection: {
    readonly runs: ReadonlyArray<
      Pick<
        OrchestrationV2Run,
        | "id"
        | "restartContinuationOfRunId"
        | "requestedAt"
        | "startedAt"
        | "completedAt"
        | "status"
        | "workStartedAt"
      >
    >;
    readonly turnItems: ReadonlyArray<RecordedWorkTurnItem>;
    readonly messages?: ReadonlyArray<
      Pick<OrchestrationV2ConversationMessage, "runId" | "role" | "updatedAt">
    >;
  } | null;
}): string | null {
  const { startedAt, runId, projection } = input;
  if (startedAt === null || runId === null || projection === null) return startedAt;
  const runs = new Map(projection.runs.map((run) => [run.id, run]));
  const current = runs.get(runId);
  if (current === undefined) return startedAt;
  if (
    startedAt !== DateTime.formatIso(current.startedAt ?? current.requestedAt) &&
    startedAt !== DateTime.formatIso(current.requestedAt) &&
    (current.workStartedAt === undefined || startedAt !== DateTime.formatIso(current.workStartedAt))
  )
    return startedAt;
  const chain = [current];
  const seen = new Set([current.id]);
  while (chain[0]!.restartContinuationOfRunId !== undefined) {
    const parentId = chain[0]!.restartContinuationOfRunId!;
    const parent = runs.get(parentId);
    if (parent === undefined || seen.has(parentId)) return startedAt;
    if (!restartContinuationResumesResponse(parent)) break;
    chain.unshift(parent);
    seen.add(parentId);
  }
  const responseStartedAt = DateTime.toEpochMillis(current.startedAt ?? current.requestedAt);
  let earlierWorkMs = 0;
  for (const run of chain.slice(0, -1)) {
    earlierWorkMs += Math.max(
      0,
      orchestrationV2RunRecordedWorkEndMs(run, projection) -
        DateTime.toEpochMillis(run.requestedAt),
    );
  }
  return DateTime.formatIso(DateTime.makeUnsafe(responseStartedAt - earlierWorkMs));
}

export type WorkLogToolLifecycleStatus = RuntimeItemStatus | "stopped" | "idle";

export function toolItemForDisplay(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution":
    case "dynamic_tool": {
      const { output: _output, ...displayItem } = item;
      return displayItem;
    }
    case "file_change": {
      const { diffStr, oldStr: _oldStr, newStr: _newStr, ...displayItem } = item;
      // A failed edit's diffStr holds the provider's error, not a diff.
      return item.status === "failed" && diffStr?.trim()
        ? { ...displayItem, diffStr }
        : displayItem;
    }
    default:
      return item;
  }
}

type CompactionLabelItem = Pick<
  Extract<OrchestrationV2TurnItem, { type: "compaction" }>,
  "status" | "beforeTokenCount" | "afterTokenCount"
>;

export function contextCompactionTokenCounts(
  item: CompactionLabelItem,
): { readonly before: string; readonly after: string } | null {
  if (
    item.status === "running" ||
    item.beforeTokenCount === undefined ||
    item.afterTokenCount === undefined
  ) {
    return null;
  }
  return { before: formatTokens(item.beforeTokenCount), after: formatTokens(item.afterTokenCount) };
}

export function contextCompactionLabel(item: CompactionLabelItem): string {
  if (item.status === "failed") return "Context compaction failed";
  if (item.status === "cancelled" || item.status === "interrupted")
    return "Context compaction stopped";
  if (isOrchestrationV2WorkActive(item.status)) return "Compacting context";
  const tokens = contextCompactionTokenCounts(item);
  return tokens
    ? `Context compacted ${tokens.before} → ${tokens.after} tokens`
    : "Context compacted";
}

export interface WorkLogPresentationEntry {
  readonly exitCode?: number;
  readonly sourceActivityKind?: string;
  readonly runId?: string | null;
  readonly turnId?: string | null;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly questionAnswer?: import("@t3tools/contracts").UserInputAttachmentAnswerPayload;
  readonly id: string;
  readonly createdAt: string;
  readonly endedAt?: string;
  readonly label: string;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly command?: string;
  readonly rawCommand?: string;
  readonly detail?: string;
  readonly viewedImagePath?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly toolTitle?: string;
  readonly toolData?: unknown;
  readonly requestKind?: string;
  readonly itemType?: OrchestrationV2TurnItem["type"];
  readonly toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  readonly structuredPayload?: OrchestrationV2TurnItem;
  readonly toolSource?: ToolActivitySource;
  readonly toolSurface?: ToolActivitySurface;
  readonly toolIcon?: ToolActivityIcon;
}

export type ToolGroupAction =
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "read"
  | "edit"
  | "memory"
  | "command"
  | "thread-create"
  | "browser"
  | "device"
  | "code-search"
  | "search"
  | "other"
  | "update";

export type ToolGroupSummaryKind =
  | "pull-request"
  | ToolGroupAction
  | "dynamic-tool"
  | "reasoning"
  | "agent-tool"
  | "tone-tool"
  | "mixed";

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function structuredWorkEntryToolName(
  entry: Pick<
    WorkLogPresentationEntry,
    "label" | "toolTitle" | "toolData" | "structuredPayload" | "toolName"
  >,
): string | undefined {
  const item = entry.structuredPayload;
  if (item?.type === "dynamic_tool" && item.toolName) return item.toolName;
  if (entry.toolName) return entry.toolName;
  const data = asRecord(entry.toolData);
  if (typeof data?.server === "string" && typeof data.tool === "string") {
    return `mcp__${data.server}__${data.tool}`;
  }
  if (typeof data?.toolName === "string") return data.toolName;
  return undefined;
}

function workEntryToolName(entry: Parameters<typeof structuredWorkEntryToolName>[0]) {
  return (
    structuredWorkEntryToolName(entry) ??
    (resolveT3McpToolDefinition(entry.toolTitle) ? entry.toolTitle : entry.label)
  );
}

function workEntryToolInput(entry: WorkLogPresentationEntry): unknown {
  return entry.structuredPayload?.type === "dynamic_tool"
    ? entry.structuredPayload.input
    : entry.toolInput;
}

function workEntryToolOutput(
  entry: Pick<WorkLogPresentationEntry, "toolData" | "structuredPayload">,
): unknown {
  const item = entry.structuredPayload;
  const data = asRecord(entry.toolData);
  return item?.type === "dynamic_tool"
    ? item.output
    : (data?.output ?? data?.result ?? data?.rawOutput ?? data?.content);
}

function resolveT3McpToolPresentation(
  definition: T3McpToolDefinition | null,
  status: string | undefined,
  data?: unknown,
) {
  if (!definition) return null;
  const detail = definition.labels[3];

  const actionKind =
    definition.summaryAction === "link-pr" ||
    definition.summaryAction === "unlink-pr" ||
    definition.summaryAction === "list-prs" ||
    definition.summaryAction === "watch-pr" ||
    definition.summaryAction === "unwatch-pr"
      ? definition.summaryAction
      : undefined;
  const payload = asRecord(data);
  const input =
    asRecord(payload?.arguments) ?? asRecord(payload?.input) ?? asRecord(payload?.rawInput);
  const urlTarget =
    typeof input?.url === "string" ? sourceControlClients.parseChangeRequestUrl(input.url) : null;
  const number = urlTarget?.link.number ?? input?.number;
  const { shortLabel } = (urlTarget?.definition ?? sourceControlClients.get(undefined))
    .changeRequest;
  const target =
    actionKind !== undefined &&
    actionKind !== "list-prs" &&
    typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number > 0
      ? `${shortLabel} #${number}`
      : detail;
  return {
    displayName: styalToolHeading(definition, status, target),
    icon: definition.icon,
    ...(actionKind === undefined ? {} : { action: actionKind }),
  };
}

export function liveActivityToolStatus(status: string | undefined, presentTense: boolean) {
  if (status === "failed" || status === "declined" || status === "stopped" || status === "idle") {
    return status;
  }
  if (presentTense || status === "inProgress") return "inProgress";
  return "completed";
}

export function resolveWorkEntryToolPresentation(
  entry: Pick<
    WorkLogPresentationEntry,
    "label" | "toolName" | "toolTitle" | "toolData" | "toolLifecycleStatus" | "structuredPayload"
  >,
  fallbackStatus?: "inProgress" | "completed",
) {
  const definition = resolveT3McpToolDefinition(workEntryToolName(entry));
  const status = entry.toolLifecycleStatus ?? fallbackStatus;
  return resolveT3McpToolPresentation(
    definition,
    definition && t3ToolResultIndicatesFailure(workEntryToolOutput(entry)) ? "failed" : status,
    entry.toolData,
  );
}

/** Web row arguments accompany the same lifecycle heading mobile and group previews use. */
export function resolveWorkEntryToolRowPresentation(entry: WorkLogPresentationEntry) {
  if (
    entry.sourceActivityKind?.startsWith("setup-script.") ||
    entry.structuredPayload?.type === "subagent"
  ) {
    return undefined;
  }
  const structuredName = structuredWorkEntryToolName(entry);
  const fallbackName = workEntryToolName(entry);
  const row = deriveToolRowPresentation({
    toolName:
      structuredName ?? (resolveT3McpToolDefinition(fallbackName) ? fallbackName : undefined),
    itemType:
      entry.itemType === "dynamic_tool"
        ? "dynamic_tool_call"
        : entry.itemType === "command_execution" ||
            entry.itemType === "file_change" ||
            entry.itemType === "web_search"
          ? entry.itemType
          : undefined,
    label: entry.toolTitle ?? entry.label,
    detail: entry.detail,
    input: workEntryToolInput(entry),
    command: entry.command,
    changedFiles: entry.changedFiles,
    failed: workEntryIndicatesToolFailure(entry),
    stopped: workEntryIsStoppedToolCall(entry),
  });
  const presentation = resolveWorkEntryToolPresentation(entry, "completed");
  return presentation ? { ...row, heading: presentation.displayName } : row;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function workLogEntryIsToolLike(entry: WorkLogPresentationEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") return true;
  if (entry.command !== undefined && entry.command.trim().length > 0) return true;
  if (entry.requestKind !== undefined) return true;
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

function workEntryIndicatesToolFailureFromOutput(
  entry: WorkLogPresentationEntry,
  includeCommand: boolean,
): boolean {
  if (
    entry.tone === "error" ||
    entry.toolLifecycleStatus === "failed" ||
    entry.toolLifecycleStatus === "declined" ||
    (entry.exitCode !== undefined && entry.exitCode !== 0)
  ) {
    return true;
  }
  // Reasoning detail is the model's own prose (often tens of KB), not tool
  // output: scanning it is slow on long threads and misreads phrases like
  // "that exit code 2 is expected" as a failed tool.
  if (!workLogEntryIsToolLike(entry) || entry.itemType === "reasoning") return false;
  if (
    resolveT3McpToolDefinition(workEntryToolName(entry)) &&
    t3ToolResultIndicatesFailure(workEntryToolOutput(entry))
  ) {
    return true;
  }
  const item = entry.structuredPayload;
  if (item?.type === "command_execution") {
    if (item.outputIndicatesFailure || (item.exitCode !== undefined && item.exitCode !== 0)) {
      return true;
    }
    if (item.output && toolOutputIndicatesFailure(item.output.slice(0, 32_768))) {
      return true;
    }
  }
  const output = includeCommand
    ? [entry.detail, entry.command].filter(Boolean).join("\n")
    : (entry.detail ?? "");
  return output.length > 0 && toolOutputIndicatesFailure(output);
}

export function workEntryIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, true);
}

export function workEntryDisplayIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, false);
}

/**
 * A tool call that ended without finishing, such as a command a server restart
 * killed. Clients show it as stopped rather than hiding it as still running.
 */
export function workEntryIsStoppedToolCall(entry: WorkLogPresentationEntry): boolean {
  return workLogEntryIsToolLike(entry) && entry.toolLifecycleStatus === "stopped";
}

export function workEntryIndicatesToolSuccess(entry: WorkLogPresentationEntry): boolean {
  return (
    workLogEntryIsToolLike(entry) &&
    !workEntryIndicatesToolFailure(entry) &&
    entry.tone !== "thinking" &&
    entry.toolLifecycleStatus !== "idle" &&
    entry.toolLifecycleStatus !== "inProgress" &&
    entry.toolLifecycleStatus !== "stopped"
  );
}

function workLogEntryIsLocalCodeSearch(entry: WorkLogPresentationEntry): boolean {
  return (
    entry.itemType === "file_search" ||
    (entry.itemType === "web_search" &&
      (typeof asRecord(workEntryToolInput(entry))?.directory_path === "string" ||
        /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label))))
  );
}

/** The Claude memory file, or memory index, that the entry wrote. */
export function workEntryMemoryFilePath(entry: WorkLogPresentationEntry) {
  return memoryFileToolPath(
    structuredWorkEntryToolName(entry),
    asRecord(workEntryToolInput(entry)) ?? undefined,
    entry.changedFiles,
    entry.itemType,
  );
}

/** Whether the entry read a Claude memory file or the memory index. */
export function workEntryReadsMemoryFile(entry: WorkLogPresentationEntry): boolean {
  return (
    memoryFileReadPath(
      structuredWorkEntryToolName(entry),
      asRecord(workEntryToolInput(entry)) ?? undefined,
    ) !== undefined
  );
}

/**
 * "Updated memory - <name>" or "Read memory - <name>", with "Updated memory
 * index" and "Read memory index" for MEMORY.md.
 */
export function memoryRowLabel(entry: WorkLogPresentationEntry): string {
  const row = resolveWorkEntryToolRowPresentation(entry);
  if (!row) return entry.label;
  return row.argument ? `${row.heading} - ${row.argument.value}` : row.heading;
}

export function workEntryMemoryFileKind(entry: WorkLogPresentationEntry) {
  return memoryFileToolKind(
    structuredWorkEntryToolName(entry),
    asRecord(workEntryToolInput(entry)) ?? undefined,
    entry.changedFiles,
    entry.itemType,
  );
}

export function toolGroupAction(entry: WorkLogPresentationEntry): ToolGroupAction {
  if (entry.itemType === "thread_created") return "thread-create";
  const presentation = resolveWorkEntryToolPresentation(entry);
  if (presentation?.action !== undefined) return presentation.action;
  if (presentation?.icon === "browser") return "browser";
  if (presentation?.icon === "device") return "device";
  if (entry.requestKind === "file-read" || entry.viewedImagePath !== undefined) return "read";
  if (entry.itemType === "approval_request" || entry.itemType === "user_input_request") {
    return workLogEntryIsToolLike(entry) ? "other" : "update";
  }
  if (workEntryMemoryFileKind(entry)) return "memory";
  const data = asRecord(entry.toolData) ?? {};
  const toolName =
    entry.structuredPayload?.type === "dynamic_tool"
      ? entry.structuredPayload.toolName
      : typeof data.toolName === "string"
        ? data.toolName
        : entry.toolTitle;
  const classified = classifyToolActivity({
    itemType:
      entry.itemType === "command_execution" ||
      entry.itemType === "file_change" ||
      entry.itemType === "web_search"
        ? entry.itemType
        : entry.itemType === "dynamic_tool"
          ? "dynamic_tool_call"
          : undefined,
    title: entry.toolTitle ?? entry.label,
    data: {
      ...data,
      ...(toolName ? { toolName } : {}),
    },
  });
  if (classified === "read") return "read";
  if (classified === "file_change" || entry.itemType === "file_change") return "edit";
  if (classified === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (classified === "search") {
    return entry.itemType === "web_search" && !workLogEntryIsLocalCodeSearch(entry)
      ? "search"
      : "code-search";
  }
  if (workLogEntryIsLocalCodeSearch(entry)) return "code-search";
  if (entry.itemType === "web_search") return "search";
  if ((entry.changedFiles?.length ?? 0) > 0) return "edit";
  return workLogEntryIsToolLike(entry) ? "other" : "update";
}

export function workEntryViewedImagePath(entry: WorkLogPresentationEntry): string | null {
  const viewedImagePath = entry.viewedImagePath?.trim();
  if (
    viewedImagePath !== undefined &&
    !/[\r\n]/.test(viewedImagePath) &&
    isWorkspaceImagePreviewPath(viewedImagePath)
  ) {
    return viewedImagePath;
  }
  const detail = entry.detail?.trim();
  return toolGroupAction(entry) === "read" &&
    detail !== undefined &&
    !/[\r\n]/.test(detail) &&
    isWorkspaceImagePreviewPath(detail)
    ? detail
    : null;
}

export interface ViewedImageAsset {
  readonly resource: Extract<AssetResource, { readonly _tag: "media-file" }>;
  readonly alt: string;
  readonly srcFragment: string;
}

export function resolveViewedImageAsset(
  source: string,
  input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot?: string | null | undefined;
  },
): ViewedImageAsset | null {
  const imageSource = classifyMarkdownImageSource(source, input.workspaceRoot ?? ".");
  if (imageSource._tag !== "WorkspaceFile") return null;
  const resolvedFilePath =
    input.workspaceRoot == null && imageSource.path.startsWith("./")
      ? imageSource.path.slice(2)
      : imageSource.path;

  const media = resolveMediaSource(source, {
    threadId: input.threadId,
    workspaceRoot: input.workspaceRoot,
    resolvedFilePath,
  });
  if (media === null || media.access !== "environment") return null;
  return { resource: media.resource, alt: media.name, srcFragment: media.srcFragment };
}

function toolGroupActionCount(
  action: ToolGroupAction,
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): number {
  if (action === "memory") {
    const memoryPaths = new Set<string>();
    for (const entry of entries) {
      if (workEntryMemoryFileKind(entry) !== "memory") continue;
      const path = workEntryMemoryFilePath(entry);
      if (path) memoryPaths.add(path);
    }
    return memoryPaths.size;
  }
  if (action !== "edit") return entries.length;
  const changedFiles = new Set<string>();
  let editsWithoutFileDetails = 0;
  for (const entry of entries) {
    if (!entry.changedFiles || entry.changedFiles.length === 0) {
      editsWithoutFileDetails += 1;
    } else {
      for (const file of entry.changedFiles) changedFiles.add(file);
    }
  }
  return changedFiles.size + editsWithoutFileDetails;
}

function toolGroupActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "link-pr":
      return `Linked ${count} ${count === 1 ? "pull request" : "pull requests"}`;
    case "unlink-pr":
      return `Unlinked ${count} ${count === 1 ? "pull request" : "pull requests"}`;
    case "watch-pr":
      return `Watching ${count} ${count === 1 ? "pull request" : "pull requests"}`;
    case "unwatch-pr":
      return `Stopped watching ${count} ${count === 1 ? "pull request" : "pull requests"}`;
    case "list-prs":
      return count === 1
        ? "Checked linked pull requests"
        : `Checked linked pull requests ${count} times`;
    case "read":
      return `Read ${count} ${count === 1 ? "file" : "files"}`;
    case "edit":
      return `Changed ${count} ${count === 1 ? "file" : "files"}`;
    case "memory":
      return count === 0
        ? "Updated memory index"
        : `Updated ${count} ${count === 1 ? "memory" : "memories"}`;
    case "command":
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "thread-create":
      return `Created ${count} ${count === 1 ? "thread" : "threads"}`;
    case "device":
      return `Used device controls ${count} ${count === 1 ? "time" : "times"}`;
    case "browser":
      return `Used browser ${count} ${count === 1 ? "time" : "times"}`;
    case "search":
      return `Searched the web ${count} ${count === 1 ? "time" : "times"}`;
    case "code-search":
      return `Searched code ${count} ${count === 1 ? "time" : "times"}`;
    case "other":
      return `Used ${count} ${count === 1 ? "tool" : "tools"}`;
    case "update":
      return `Received ${count} ${count === 1 ? "update" : "updates"}`;
  }
}

function t3ToolSummaryCall(entry: WorkLogPresentationEntry): T3ToolSummaryCall {
  const item = entry.structuredPayload;
  const data =
    entry.toolData !== null && typeof entry.toolData === "object"
      ? (entry.toolData as Record<string, unknown>)
      : undefined;
  return {
    input:
      item?.type === "dynamic_tool"
        ? item.input
        : (data?.arguments ?? data?.input ?? data?.rawInput),
    output: workEntryToolOutput(entry),
    outcome:
      entry.toolLifecycleStatus === "failed" ||
      entry.toolLifecycleStatus === "declined" ||
      entry.tone === "error"
        ? "failed"
        : entry.toolLifecycleStatus === "completed"
          ? "completed"
          : "unfinished",
  };
}

function summaryActionPriority(action: ToolGroupAction | T3McpToolSummaryAction): number {
  switch (action) {
    case "command":
    case "edit":
    case "delegate":
    case "task-cancel":
    case "thread-create":
    case "thread-send":
    case "thread-interrupt":
    case "workflow-stop":
    case "schedule-create":
    case "schedule-update":
    case "schedule-delete":
    case "schedule-run":
    case "thread-configure":
    case "thread-fork":
    case "thread-merge":
    case "thread-organize":
    case "thread-update":
    case "queue-edit":
    case "queue-cancel":
    case "queue-reorder":
    case "queue-steer":
    case "question-respond":
    case "worktree-handoff":
    case "project-create":
    case "project-update":
    case "project-delete":
    case "project-clone":
    case "environment-update":
    case "attachment-prepare":
    case "attachment-discard":
    case "attachment-send":
      return 0;
    case "other":
    case "update":
      return 2;
    default:
      return 1;
  }
}

export function summarizeToolGroup(entries: ReadonlyArray<WorkLogPresentationEntry>): {
  summary: string;
  hasFailure: boolean;
} {
  const toolEntries = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && toolEntries.length === 0) {
    return {
      summary: entries.length === 1 ? "Thought" : `Thought (×${entries.length})`,
      hasFailure: false,
    };
  }
  entries = toolEntries;
  const groups = new Map<
    ToolGroupAction | T3McpToolSummaryAction,
    {
      action: ToolGroupAction;
      t3Action: T3McpToolSummaryAction | null;
      entries: WorkLogPresentationEntry[];
    }
  >();
  const sources = new Map<string, ToolActivitySource>();
  for (const entry of entries) {
    const t3Action = resolveT3McpToolDefinition(workEntryToolName(entry))?.summaryAction ?? null;
    if (entry.toolSource && t3Action === null) {
      sources.set(entry.toolSource.key, entry.toolSource);
      continue;
    }
    const action = toolGroupAction(entry);
    const key = t3Action ?? action;
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { action, t3Action, entries: [entry] });
  }
  const summaries = [...groups].map(([action, group], index) => ({
    index,
    count: group.entries.length,
    priority: summaryActionPriority(action),
    ...(group.t3Action
      ? summarizeT3ToolCalls(group.t3Action, group.entries.map(t3ToolSummaryCall))
      : {
          label: toolGroupActionLabel(
            group.action,
            toolGroupActionCount(group.action, group.entries),
          ),
          failedCount: group.entries.filter(workEntryDisplayIndicatesToolFailure).length,
        }),
  }));
  const selected = [...summaries]
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);
  const labels = selected.map(({ label }) => label);
  if (sources.size > 0) {
    const sourceValues = [...sources.values()];
    const sourceNames = [...new Set(sourceValues.map((source) => source.name))];
    const formattedNames =
      sourceNames.length < 2
        ? sourceNames[0]!
        : sourceNames.length === 2
          ? sourceNames.join(" and ")
          : `${sourceNames.slice(0, -1).join(", ")}, and ${sourceNames.at(-1)}`;
    const allIntegrations = sourceValues.every((source) => source.kind === "integration");
    labels.unshift(
      `Used ${formattedNames}${allIntegrations ? ` ${sourceNames.length === 1 ? "integration" : "integrations"}` : ""}`,
    );
  }
  const sourcedCount = entries.filter(
    (entry) =>
      entry.toolSource !== undefined &&
      resolveT3McpToolDefinition(workEntryToolName(entry)) === null,
  ).length;
  const remainingCount =
    entries.length - sourcedCount - selected.reduce((count, group) => count + group.count, 0);
  if (remainingCount > 0) {
    labels.push(`Performed ${remainingCount} other ${remainingCount === 1 ? "action" : "actions"}`);
  }
  const sentenceLabels = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  const summary =
    sentenceLabels.length < 3
      ? sentenceLabels.join(" and ")
      : `${sentenceLabels.slice(0, -1).join(", ")}, and ${sentenceLabels.at(-1)}`;
  return { summary, hasFailure: summaries.some((group) => group.failedCount > 0) };
}

export function toolGroupSummaryKind(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): ToolGroupSummaryKind {
  const toolEntries = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && toolEntries.length === 0) return "reasoning";
  entries = toolEntries;
  if (
    entries.length > 0 &&
    entries.every((entry) => resolveWorkEntryToolPresentation(entry)?.icon === "pull-request")
  )
    return "pull-request";
  const actions = new Set(entries.map(toolGroupAction));
  if (actions.size !== 1) return "mixed";
  const action = actions.values().next().value!;
  if (action !== "other") return action;
  const fallbackKinds = new Set(
    entries.map((entry): ToolGroupSummaryKind => {
      if (entry.itemType === "dynamic_tool") return "dynamic-tool";
      if (entry.itemType === "subagent") return "agent-tool";
      if (entry.tone === "thinking") return "agent-tool";
      if (entry.tone === "tool") return "tone-tool";
      return "other";
    }),
  );
  return fallbackKinds.size === 1 ? fallbackKinds.values().next().value! : "mixed";
}

/**
 * The findings an accepted `ReportFindings` call carries. Clients render these
 * as a findings card in place of the tool row.
 */
export function workEntryReviewFindings(
  entry: WorkLogPresentationEntry,
): ReviewFindingsReport | undefined {
  if (
    !isReportFindingsToolName(workEntryToolName(entry)) ||
    entry.toolLifecycleStatus !== "completed"
  ) {
    return undefined;
  }
  return readReviewFindingsReport(workEntryToolInput(entry));
}

/**
 * Drops `ReportFindings` calls the tool rejected (usually a label over its
 * length limit) when the agent resubmitted an accepted report later in the
 * same turn. Only the accepted report is worth showing; a rejection with no
 * retry stays visible.
 */
export function omitRetriedFindingsReports<T extends WorkLogPresentationEntry>(
  entries: ReadonlyArray<T>,
): T[] {
  const acceptedTurnIds = new Set<string | null>();
  const kept: T[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (isReportFindingsToolName(workEntryToolName(entry))) {
      const turnId = entry.runId ?? entry.turnId ?? null;
      if (workEntryReviewFindings(entry)) {
        acceptedTurnIds.add(turnId);
      } else if (entry.toolLifecycleStatus === "failed" && acceptedTurnIds.has(turnId)) {
        continue;
      }
    }
    kept.push(entry);
  }
  // Hermes lacks toReversed; this array is local, so reversing it cannot mutate the input.
  // oxlint-disable-next-line unicorn/no-array-reverse
  return kept.reverse();
}

export function liveThoughtLine(markdown: string): string {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (heading !== undefined) return text;
  const end = /[.?!]["'”’)]?(?=\s)/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}
