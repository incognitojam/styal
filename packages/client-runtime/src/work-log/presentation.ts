import {
  isToolLifecycleItemType,
  SERVER_RESTART_BACKGROUND_ACTIVITY_KIND,
  SERVER_RESTART_CONTINUED_ACTIVITY_KIND,
  type AssetResource,
  type RuntimeItemStatus,
  type ThreadId,
  type ToolActivitySource,
  type ToolLifecycleItemType,
  type TurnId,
} from "@t3tools/contracts";
import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import {
  isReportFindingsToolName,
  readReviewFindingsReport,
  type ReviewFindingsReport,
} from "@t3tools/shared/reviewFindings";
import { memoryFileToolKind, memoryFileToolPath } from "@t3tools/shared/toolRowPresentation";

/**
 * Activity kinds clients show as a row of their own: never merged into a
 * group of work rows, and still visible when a folded turn has nothing else
 * to hide. Compaction breaks the agent's context, so it is drawn as a divider;
 * a restart continues the same conversation, so it is drawn as a note in the
 * turn's work.
 */
const STANDALONE_TIMELINE_ACTIVITY_STYLES = {
  "context-compaction": "divider",
  [SERVER_RESTART_CONTINUED_ACTIVITY_KIND]: "restart-note",
  [SERVER_RESTART_BACKGROUND_ACTIVITY_KIND]: "restart-note",
} as const;

export type StandaloneTimelineActivityStyle =
  (typeof STANDALONE_TIMELINE_ACTIVITY_STYLES)[keyof typeof STANDALONE_TIMELINE_ACTIVITY_STYLES];

/** How clients draw a standalone activity, or undefined when the kind is not one. */
export function standaloneTimelineActivityStyle(
  kind: string | undefined,
): StandaloneTimelineActivityStyle | undefined {
  return kind !== undefined && Object.hasOwn(STANDALONE_TIMELINE_ACTIVITY_STYLES, kind)
    ? STANDALONE_TIMELINE_ACTIVITY_STYLES[kind as keyof typeof STANDALONE_TIMELINE_ACTIVITY_STYLES]
    : undefined;
}

export function isStandaloneTimelineActivityKind(kind: string | undefined): kind is string {
  return standaloneTimelineActivityStyle(kind) !== undefined;
}

/** What deriveContinuedTurnRoots reads from one timeline entry. */
export interface ContinuedTurnEntry {
  /** The provider turn the entry belongs to, or null when it has none. */
  readonly turnId: TurnId | null;
  readonly isUserMessage: boolean;
  readonly activityKind: string | undefined;
}

/**
 * A prompted continuation after a server restart runs in a new provider turn
 * with no user message before it. Maps each such turn, recognised by the
 * restart note that opens it, to the turn it continued so clients fold both as
 * one response. Every other turn maps to itself. Entries must be in timeline
 * order.
 */
export function deriveContinuedTurnRoots<Entry>(
  entries: Iterable<Entry>,
  describe: (entry: Entry) => ContinuedTurnEntry,
): ReadonlyMap<TurnId, TurnId> {
  const roots = new Map<TurnId, TurnId>();
  let previousRoot: TurnId | null = null;
  for (const entry of entries) {
    const { turnId, isUserMessage, activityKind } = describe(entry);
    if (isUserMessage) {
      previousRoot = null;
      continue;
    }
    if (turnId === null) {
      continue;
    }
    let root = roots.get(turnId);
    if (root === undefined) {
      root =
        previousRoot !== null && activityKind === SERVER_RESTART_CONTINUED_ACTIVITY_KIND
          ? previousRoot
          : turnId;
      roots.set(turnId, root);
    }
    previousRoot = root;
  }
  return roots;
}

/** What restartDowntimeMs reads from one entry of a response. */
export interface RestartDowntimeEntry {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly endedAt: string;
}

/**
 * Time a response spent waiting for the server to restart: for each turn that
 * continued another, the gap between the last entry before it and its first
 * entry. Subtract it from the response's duration so a long outage does not
 * count as work. Entries must be one response's entries in timeline order.
 */
export function restartDowntimeMs<Entry>(
  entries: Iterable<Entry>,
  describe: (entry: Entry) => RestartDowntimeEntry,
): number {
  let downtimeMs = 0;
  let previousTurnId: TurnId | null = null;
  let previousEndMs: number | null = null;
  for (const entry of entries) {
    const { turnId, startedAt, endedAt } = describe(entry);
    const startMs = Date.parse(startedAt);
    if (
      previousTurnId !== null &&
      turnId !== previousTurnId &&
      previousEndMs !== null &&
      Number.isFinite(startMs)
    ) {
      downtimeMs += Math.max(0, startMs - previousEndMs);
    }
    previousTurnId = turnId;
    const endMs = Date.parse(endedAt);
    if (Number.isFinite(endMs)) {
      previousEndMs = previousEndMs === null ? endMs : Math.max(previousEndMs, endMs);
    }
  }
  return downtimeMs;
}

export function isWorktreeSetupActivity(kind: string): boolean {
  return kind === "setup-script.requested" || kind === "setup-script.started";
}

export type WorkLogToolLifecycleStatus = RuntimeItemStatus | "stopped";

export interface WorkLogPresentationEntry {
  readonly label: string;
  readonly toolTitle?: string;
  readonly toolName?: string;
  readonly toolInput?: Record<string, unknown>;
  readonly toolData?: unknown;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly command?: string;
  readonly detail?: string;
  readonly viewedImagePath?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly itemType?: ToolLifecycleItemType;
  readonly requestKind?: string;
  readonly turnId?: string | null;
  readonly toolCallId?: string;
  readonly toolLifecycleStatus?: string;
  readonly exitCode?: number | undefined;
  readonly sourceActivityKind?: string;
  readonly taskId?: string;
  readonly toolSource?: ToolActivitySource;
}

export type ToolGroupAction =
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "read"
  | "edit"
  | "memory"
  | "command"
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
  | "agent-tool"
  | "tone-tool"
  | "mixed";

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

const T3_MCP_TOOL_LABELS: Record<
  string,
  readonly [action: string, running: string, completed: string, detail: string]
> = {
  link_pull_request: ["Link", "Linking", "Linked", "a pull request"],
  unlink_pull_request: ["Unlink", "Unlinking", "Unlinked", "a pull request"],
  list_thread_pull_requests: ["Check", "Checking", "Checked", "linked pull requests"],
  orchestrator_capabilities: ["Get", "Getting", "Got", "orchestration capabilities"],
  delegate_task: ["Delegate", "Delegating", "Delegated", "a child task"],
  task_status: ["Get", "Getting", "Got", "delegated task status"],
  task_cancel: ["Cancel", "Canceling", "Canceled", "delegated task"],
  schedule_task: ["Schedule", "Scheduling", "Scheduled", "a recurring task"],
  list_scheduled_tasks: ["List", "Listing", "Listed", "scheduled tasks"],
  update_scheduled_task: ["Update", "Updating", "Updated", "a scheduled task"],
  delete_scheduled_task: ["Delete", "Deleting", "Deleted", "a scheduled task"],
  create_threads: ["Create", "Creating", "Created", "T3 threads"],
  t3_thread_start: ["Start", "Starting", "Started", "a T3 thread"],
  t3_thread_list: ["List", "Listing", "Listed", "T3 threads"],
  t3_thread_read: ["Read", "Reading", "Read", "a T3 thread"],
  t3_thread_send: ["Send", "Sending", "Sent", "to a T3 thread"],
  t3_thread_wait: ["Wait", "Waiting", "Waited", "for a T3 thread"],
  t3_thread_interrupt: ["Interrupt", "Interrupting", "Interrupted", "a T3 thread"],
  t3_worktree_handoff: ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
  t3_worktree_status: ["Get", "Getting", "Got", "thread worktree status"],
  preview_status: ["Get", "Getting", "Got", "preview browser status"],
  preview_open: ["Open", "Opening", "Opened", "a page in the preview browser"],
  preview_navigate: ["Navigate", "Navigating", "Navigated", "the preview browser"],
  preview_snapshot: [
    "Take a snapshot of",
    "Taking a snapshot of",
    "Took a snapshot of",
    "the preview page",
  ],
  preview_click: ["Click", "Clicking", "Clicked", "in the preview browser"],
  preview_press: ["Press", "Pressing", "Pressed", "a key in the preview browser"],
  preview_type: ["Type", "Typing", "Typed", "in the preview browser"],
  preview_scroll: ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
  preview_resize: ["Resize", "Resizing", "Resized", "the preview browser"],
  preview_evaluate: ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
  preview_wait_for: ["Wait", "Waiting", "Waited", "for the preview page"],
  preview_set_appearance: ["Set", "Setting", "Set", "preview browser appearance"],
  preview_recording_start: ["Start", "Starting", "Started", "recording the preview browser"],
  preview_recording_stop: ["Stop", "Stopping", "Stopped", "recording the preview browser"],
  device_list: ["List", "Listing", "Listed", "simulators and emulators"],
  device_open: ["Open", "Opening", "Opened", "a device in the Device panel"],
  device_screenshot: [
    "Take a screenshot of",
    "Taking a screenshot of",
    "Took a screenshot of",
    "the device",
  ],
  device_close: ["Close", "Closing", "Closed", "a device"],
};

const PR_TOOL_ACTIONS: Readonly<Record<string, ToolGroupAction>> = {
  link_pull_request: "link-pr",
  unlink_pull_request: "unlink-pr",
  list_thread_pull_requests: "list-prs",
};

function resolveT3McpToolPresentation(
  value: string | undefined,
  status: string | undefined,
  data?: unknown,
) {
  if (!value) return null;
  const name = normalizeCompactToolLabel(value).replace(
    /^(?:mcp__(?:t3-code|t3_code|t3code)__|(?:t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*))/i,
    "",
  );
  if (!Object.hasOwn(T3_MCP_TOOL_LABELS, name)) return null;

  const [action, running, completed, detail] = T3_MCP_TOOL_LABELS[name]!;
  const verb =
    status === "inProgress"
      ? running
      : status === "completed"
        ? completed
        : status === "failed"
          ? `Failed to ${action.toLowerCase()}`
          : status === "declined"
            ? `Declined to ${action.toLowerCase()}`
            : status === "stopped"
              ? `Stopped ${running.toLowerCase()}`
              : running;

  const actionKind = Object.hasOwn(PR_TOOL_ACTIONS, name) ? PR_TOOL_ACTIONS[name] : undefined;
  const payload = asRecord(data);
  const input =
    asRecord(payload?.arguments) ?? asRecord(payload?.input) ?? asRecord(payload?.rawInput);
  const urlTarget = typeof input?.url === "string" ? parseChangeRequestUrl(input.url) : null;
  const number = urlTarget?.number ?? input?.number;
  const target =
    actionKind !== undefined &&
    actionKind !== "list-prs" &&
    typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number > 0
      ? `PR #${number}`
      : detail;
  return {
    displayName: `${verb} ${target}`,
    icon:
      actionKind !== undefined
        ? ("pull-request" as const)
        : name.startsWith("preview_")
          ? ("browser" as const)
          : name.startsWith("device_")
            ? ("device" as const)
            : ("t3-code" as const),
    ...(actionKind === undefined ? {} : { action: actionKind }),
  };
}

/** Latest live activity stays present-tense unless the call itself failed, declined, or stopped. */
export function liveActivityToolStatus(status: string | undefined, presentTense: boolean) {
  if (status === "failed" || status === "declined" || status === "stopped") return status;
  if (presentTense || status === "inProgress") return "inProgress";
  return "completed";
}

/** Resolves tool identity before choosing labels or icons in either client. */
export function resolveWorkEntryToolPresentation(
  entry: Pick<WorkLogPresentationEntry, "label" | "toolTitle" | "toolData" | "toolLifecycleStatus">,
  fallbackStatus?: "inProgress" | "completed",
) {
  const status = entry.toolLifecycleStatus ?? fallbackStatus;
  const data = entry.toolData;
  if (data !== null && typeof data === "object") {
    if (
      "server" in data &&
      typeof data.server === "string" &&
      "tool" in data &&
      typeof data.tool === "string"
    ) {
      return resolveT3McpToolPresentation(`${data.server}.${data.tool}`, status, data);
    }
    if ("toolName" in data && typeof data.toolName === "string") {
      return resolveT3McpToolPresentation(data.toolName, status, data);
    }
  }

  return (
    resolveT3McpToolPresentation(entry.toolTitle, status, data) ??
    resolveT3McpToolPresentation(entry.label, status, data)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function commandResultContent(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct) return direct;

  const directContent = Array.isArray(value) ? value : null;
  const record = asRecord(value);
  const content = record?.content;
  const contentText = nonEmptyString(content);
  if (contentText) return contentText;
  const blocks = directContent ?? (Array.isArray(content) ? content : null);
  if (!blocks) return null;

  const chunks = blocks.flatMap((entry) => {
    const text = nonEmptyString(entry) ?? nonEmptyString(asRecord(entry)?.text);
    return text ? [text] : [];
  });
  return chunks.length > 0 ? chunks.join("\n") : null;
}

/** Returns provider command output before it is formatted for a work-log row. */
export function extractCommandOutputText(dataValue: unknown): string | null {
  const data = asRecord(dataValue);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const rawOutput = asRecord(data?.rawOutput);
  const outputStreams = [
    nonEmptyString(rawOutput?.stdout),
    nonEmptyString(rawOutput?.stderr),
  ].filter((value): value is string => value !== null);
  const acpContent = Array.isArray(data?.content)
    ? data.content
        .flatMap((entryValue) => {
          const entry = asRecord(entryValue);
          const content = asRecord(entry?.content);
          const text = entry?.type === "content" ? nonEmptyString(content?.text) : null;
          return text ? [text] : [];
        })
        .join("\n")
    : null;

  const candidates = [
    item?.aggregatedOutput,
    itemResult?.content,
    data?.rawOutput,
    rawOutput?.content,
    outputStreams.length > 0 ? outputStreams.join("\n") : null,
    rawOutput?.output,
    acpContent,
    data?.result,
  ];
  for (const candidate of candidates) {
    const text = commandResultContent(candidate);
    if (text) return text;
  }
  return null;
}

/**
 * Ingestion caps tool details at 180 chars and appends "...", so a long command
 * echo no longer equals the command it repeats. Treat a truncated prefix of the
 * command as the same echo.
 */
function textRepeatsCommand(text: string, commands: ReadonlyArray<string | null>): boolean {
  const truncated = text.endsWith("...")
    ? text.slice(0, -3)
    : text.endsWith("\u2026")
      ? text.slice(0, -1)
      : null;
  return commands.some((candidate) => {
    const command = candidate?.trim();
    if (!command) return false;
    if (command === text) return true;
    return (
      truncated !== null &&
      truncated.length > 0 &&
      command.length > truncated.length &&
      command.startsWith(truncated)
    );
  });
}

/**
 * Decides whether a command row's `detail` is a synthetic echo of the command
 * rather than real output. OpenCode stores completed output in `detail` with no
 * other output channel, so plain equality is only treated as synthetic when the
 * payload shape shows the detail came from the command: Codex item metadata,
 * an ACP tool call (`data.toolCallId`, `kind: "execute"`), a Claude tool-name
 * prefix, or no structured command at all.
 */
export function commandDetailRepeatsCommand(input: {
  readonly detail: string;
  readonly command: string | null;
  readonly rawCommand: string | null;
  readonly toolName: unknown;
  readonly data: unknown;
}): boolean {
  const toolName = nonEmptyString(input.toolName)?.trim();
  const detail = input.detail.trim();
  const commands = [input.command, input.rawCommand];
  if (toolName) {
    const prefix = `${toolName}:`;
    if (detail.toLowerCase().startsWith(prefix.toLowerCase())) {
      const unprefixed = detail.slice(prefix.length).trim();
      if (textRepeatsCommand(unprefixed, commands)) return true;
    }
  }

  if (!textRepeatsCommand(detail, commands)) return false;

  const data = asRecord(input.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const hasStructuredCommand = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
  ].some((value) =>
    Array.isArray(value)
      ? value.some((part) => nonEmptyString(part) !== null)
      : nonEmptyString(value) !== null,
  );
  return (
    !hasStructuredCommand ||
    item !== null ||
    data?.toolCallId !== undefined ||
    nonEmptyString(data?.kind)?.toLowerCase() === "execute"
  );
}

export function workLogEntryIsToolLike(entry: WorkLogPresentationEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") return true;
  if (entry.command !== undefined && entry.command.trim().length > 0) return true;
  if (entry.requestKind !== undefined) return true;
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

/** Maps item and task status to the status shown on a work-log row. */
export function extractWorkLogToolLifecycleStatus(
  payloadValue: unknown,
): WorkLogToolLifecycleStatus | undefined {
  const payload = asRecord(payloadValue);
  switch (payload?.status) {
    case "pending":
    case "running":
    case "waiting":
      return "inProgress";
    case "cancelled":
    case "interrupted":
      return "stopped";
    case "idle":
      // A batch becomes idle when its parent turn ends. Other idle tasks can resume.
      return payload.taskType === "subagent_batch" ? "stopped" : undefined;
    case "inProgress":
    case "completed":
    case "failed":
    case "declined":
    case "stopped":
      return payload.status;
    default:
      return undefined;
  }
}

/**
 * How a background task (a backgrounded shell command or a monitor) ended
 * after the tool call that launched it had already returned. Clients show it
 * on the launching tool row instead of as a separate row wherever the task
 * happened to end.
 */
export interface WorkLogBackgroundOutcome {
  readonly status: "completed" | "failed" | "stopped";
  /** The provider's account of the ending, when it says more than the task title. */
  readonly summary?: string;
}

/** Reads the outcome from a background task's terminal activity payload. */
export function extractBackgroundTaskOutcome(
  payloadValue: unknown,
): WorkLogBackgroundOutcome | undefined {
  const payload = asRecord(payloadValue);
  const status = extractWorkLogToolLifecycleStatus(payload);
  if (status !== "completed" && status !== "failed" && status !== "stopped") return undefined;
  const summary = nonEmptyString(payload?.summary);
  const informativeSummary = summary !== null && summary !== payload?.title ? summary : undefined;
  // A foreground command that ran long enough to become a task completes
  // with only its title; the tool call's own result already says the rest.
  if (status === "completed" && informativeSummary === undefined) return undefined;
  return { status, ...(informativeSummary ? { summary: informativeSummary } : {}) };
}

export function backgroundOutcomeLabel(outcome: WorkLogBackgroundOutcome): string {
  if (outcome.summary) return outcome.summary;
  return outcome.status === "completed"
    ? "Completed in the background"
    : outcome.status === "failed"
      ? "Failed in the background"
      : "Stopped in the background";
}

// Some providers report completion even when the output describes a failure.
function toolDetailTextLooksLikeFailure(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("file not found") ||
    normalized.includes("no files found") ||
    normalized.includes("enoent") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("no such file") ||
    normalized.includes("commandnotfoundexception") ||
    normalized.includes("command not found") ||
    normalized.includes("could not find oldstring in the file") ||
    (normalized.includes("cannot find path") && normalized.includes("because it does not exist")) ||
    (normalized.includes("is not recognized") && normalized.includes("the term '")) ||
    normalized.includes("is not recognized as the name of a cmdlet") ||
    normalized.includes("a parameter cannot be found that matches parameter name") ||
    /<exited with exit code\s+[1-9]\d*\s*>/i.test(text) ||
    /exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text) ||
    /exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)
  );
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
  if (!workLogEntryIsToolLike(entry)) return false;
  const output = includeCommand
    ? [entry.detail, entry.command].filter(Boolean).join("\n")
    : (entry.detail ?? "");
  return output.length > 0 && toolDetailTextLooksLikeFailure(output);
}

/** Includes legacy activities that stored error output in the command field. */
export function workEntryIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, true);
}

/** Checks rendered output without treating the user's command as an error. */
export function workEntryDisplayIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, false);
}

/**
 * A tool call that ended without finishing, such as a command a server restart
 * killed. Clients show it as stopped rather than hiding it as still running.
 */
export function workEntryIsStoppedToolCall(entry: WorkLogPresentationEntry): boolean {
  return entry.sourceActivityKind === "tool.completed" && entry.toolLifecycleStatus === "stopped";
}

/** Decides whether the row can show a success marker. */
export function workEntryIndicatesToolSuccess(entry: WorkLogPresentationEntry): boolean {
  return (
    workLogEntryIsToolLike(entry) &&
    !workEntryIndicatesToolFailure(entry) &&
    entry.tone !== "thinking" &&
    entry.toolLifecycleStatus !== "inProgress" &&
    entry.toolLifecycleStatus !== "stopped"
  );
}

function workLogEntryIsLocalCodeSearch(entry: WorkLogPresentationEntry): boolean {
  return (
    entry.itemType === "web_search" &&
    /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label))
  );
}

export function toolGroupAction(entry: WorkLogPresentationEntry): ToolGroupAction {
  if (
    entry.sourceActivityKind === "approval.requested" ||
    entry.sourceActivityKind === "approval.resolved" ||
    entry.sourceActivityKind === "provider.approval.respond.failed"
  ) {
    return "update";
  }
  if (memoryFileToolKind(entry.toolName, entry.toolInput, entry.changedFiles)) return "memory";
  switch (entry.toolName) {
    case "Read":
      return "read";
    case "Glob":
    case "Grep":
      return "code-search";
    case "WebFetch":
    case "WebSearch":
      return "search";
    case "SendMessage":
    case "TaskCreate":
    case "TaskList":
    case "TaskUpdate":
    case "ToolSearch":
      return "other";
  }

  const presentation = resolveWorkEntryToolPresentation(entry);
  if (presentation?.action !== undefined) return presentation.action;
  if (presentation?.icon === "browser") return "browser";
  if (presentation?.icon === "device") return "device";
  if (
    entry.requestKind === "file-read" ||
    entry.itemType === "image_view" ||
    entry.viewedImagePath !== undefined ||
    (entry.itemType === "dynamic_tool_call" &&
      entry.toolTitle?.trim().toLowerCase() === "read file")
  ) {
    return "read";
  }
  if (
    entry.requestKind === "file-change" ||
    entry.itemType === "file_change" ||
    (entry.changedFiles?.length ?? 0) > 0
  ) {
    return "edit";
  }
  if (entry.requestKind === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (workLogEntryIsLocalCodeSearch(entry)) return "code-search";
  if (entry.itemType === "web_search") return "search";
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
  // A relative path with no known workspace still names a media-file relative
  // to the thread's workspace, so classify against "." and drop the prefix.
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
      if (memoryFileToolKind(entry.toolName, entry.toolInput, entry.changedFiles) !== "memory") {
        continue;
      }
      const path = memoryFileToolPath(entry.toolName, entry.toolInput, entry.changedFiles);
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
      continue;
    }
    for (const file of entry.changedFiles) changedFiles.add(file);
  }
  return changedFiles.size + editsWithoutFileDetails;
}

function toolGroupActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "link-pr":
      return `Linked ${count} ${count === 1 ? "pull request" : "pull requests"}`;
    case "unlink-pr":
      return `Unlinked ${count} ${count === 1 ? "pull request" : "pull requests"}`;
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

export function summarizeToolGroup(entries: ReadonlyArray<WorkLogPresentationEntry>): string {
  const summaryEntries = omitSupersededLifecycleMarkers(entries, (entry) => entry);
  const sources = new Map<string, ToolActivitySource>();
  const groupedEntries = new Map<ToolGroupAction, WorkLogPresentationEntry[]>();
  for (const entry of summaryEntries) {
    if (entry.toolSource && resolveWorkEntryToolPresentation(entry)?.icon !== "pull-request") {
      sources.set(entry.toolSource.key, entry.toolSource);
      continue;
    }
    const action = toolGroupAction(entry);
    const group = groupedEntries.get(action);
    if (group) group.push(entry);
    else groupedEntries.set(action, [entry]);
  }
  const labels = [...groupedEntries].map(([action, actionEntries]) =>
    toolGroupActionLabel(action, toolGroupActionCount(action, actionEntries)),
  );
  if (sources.size > 0) {
    const sourceValues = [...sources.values()];
    const sourceNames = sourceValues.map((source) => source.name);
    const formattedNames =
      sourceNames.length < 2
        ? sourceNames[0]!
        : sourceNames.length === 2
          ? sourceNames.join(" and ")
          : `${sourceNames.slice(0, -1).join(", ")}, and ${sourceNames.at(-1)}`;
    const allIntegrations = sourceValues.every((source) => source.kind === "integration");
    labels.unshift(
      `Used ${formattedNames}${allIntegrations ? ` ${sources.size === 1 ? "integration" : "integrations"}` : ""}`,
    );
  }
  const sentenceLabels = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  if (sentenceLabels.length < 2) return sentenceLabels[0] ?? "";
  if (sentenceLabels.length === 2) return sentenceLabels.join(" and ");
  return `${sentenceLabels.slice(0, -1).join(", ")}, and ${sentenceLabels.at(-1)}`;
}

export function omitSupersededLifecycleMarkers<T>(
  entries: readonly T[],
  workEntryFor: (entry: T) => WorkLogPresentationEntry,
): T[] {
  const laterTerminalIdentities = new Set<string>();
  const reversedEntries: T[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const workEntry = workEntryFor(entry);
    const normalizedLabel = normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label);
    const identity = [
      workEntry.turnId ?? "no-turn",
      workEntry.itemType ?? "",
      normalizedLabel,
    ].join("\u001f");
    const activityKind = workEntry.sourceActivityKind;
    const isStatuslessIdlessMarker =
      workEntry.toolCallId === undefined &&
      workEntry.toolLifecycleStatus === undefined &&
      (activityKind === "tool.started" || activityKind === "tool.updated");
    if (isStatuslessIdlessMarker && laterTerminalIdentities.has(identity)) continue;

    reversedEntries.push(entry);
    if (
      activityKind === "tool.completed" ||
      (workEntry.toolLifecycleStatus !== undefined &&
        workEntry.toolLifecycleStatus !== "inProgress")
    ) {
      laterTerminalIdentities.add(identity);
    }
  }

  // Hermes lacks toReversed; this array is local, so reversing it cannot mutate the input.
  // oxlint-disable-next-line unicorn/no-array-reverse
  return reversedEntries.reverse();
}

export function toolGroupSummaryKind(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): ToolGroupSummaryKind {
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
      if (entry.itemType === "mcp_tool_call") return "other";
      if (entry.itemType === "dynamic_tool_call") return "dynamic-tool";
      if (entry.itemType === "collab_agent_tool_call" || entry.taskId) return "agent-tool";
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
  if (!isReportFindingsToolName(entry.toolName) || entry.toolLifecycleStatus !== "completed") {
    return undefined;
  }
  return readReviewFindingsReport(entry.toolInput);
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
    if (isReportFindingsToolName(entry.toolName)) {
      const turnId = entry.turnId ?? null;
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
