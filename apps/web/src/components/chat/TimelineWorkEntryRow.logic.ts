import type { Root, RootContent } from "mdast";
import {
  resolveWorkEntryToolPresentation,
  resolveWorkEntryToolRowPresentation,
} from "@t3tools/client-runtime/work-log/presentation";
import { type OrchestrationGetCommandOutputResult } from "@t3tools/contracts";
import {
  formatAskUserQuestionBody,
  isPreviewToolName,
  normalizeKnownToolName,
  type ToolRowArgument,
  type ToolRowPresentation,
} from "@t3tools/shared/toolRowPresentation";
import { isJavaScriptReplTool } from "@t3tools/shared/toolActivity";
import { normalizeCompactToolLabel, toolGroupAction } from "./MessagesTimeline.logic";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { type TimelineWorkEntry, type TimelineRow } from "./timelineRowContext";
import { SETUP_ACTION_ICON_NAME, type WorkEntryIconName } from "./TimelineToolActivityIcon";

export function toolGroupSummaryIconName(
  kind: Extract<TimelineRow, { kind: "work-toggle" }>["summaryKind"],
): WorkEntryIconName {
  switch (kind) {
    case "pull-request":
    case "link-pr":
    case "unlink-pr":
    case "list-prs":
    case "watch-pr":
    case "unwatch-pr":
      return "pull-request";
    case "read":
      return "eye";
    case "edit":
      return "square-pen";
    case "memory":
      return "brain";
    case "command":
      return "terminal";
    case "thread-create":
      return "t3-code";
    case "browser":
      return "browser";
    case "device":
      return "device";
    case "search":
      return "globe";
    case "code-search":
      return "search";
    case "other":
      return "wrench";
    case "dynamic-tool":
      return "hammer";
    case "reasoning":
      return "brain";
    case "agent-tool":
      return "bot";
    case "tone-tool":
      return "zap";
    case "update":
    case "mixed":
      return "hammer";
  }
}

export function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  iconName: WorkEntryIconName;
  className: string;
} {
  if (tone === "error") {
    return {
      iconName: "circle-alert",
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      iconName: "brain",
      className: "text-icon-muted",
    };
  }
  if (tone === "info") {
    return {
      iconName: "check",
      className: "text-muted-foreground",
    };
  }
  return {
    iconName: "zap",
    className: "text-foreground/92",
  };
}

/**
 * One vocabulary for every provider, derived at render time. See
 * `toolRowPresentation` for why this must not be written back onto the entry.
 */
export function toolRowPresentationFor(workEntry: TimelineWorkEntry) {
  return resolveWorkEntryToolRowPresentation(workEntry);
}

function formatToolRowArgument(
  argument: ToolRowArgument,
  workspaceRoot: string | undefined,
): string {
  if (argument.kind !== "path") {
    return argument.value;
  }
  const displayPath = formatToolFilePath(argument.value, workspaceRoot);
  return argument.moreCount ? `${displayPath} +${argument.moreCount} more` : displayPath;
}

export function toolRowDisplayText(
  presentation: ToolRowPresentation,
  workspaceRoot: string | undefined,
): string {
  const { heading } = presentation;
  const rawArgument = presentation.argument
    ? formatToolRowArgument(presentation.argument, workspaceRoot)
    : null;
  const argument =
    rawArgument &&
    normalizeCompactToolLabel(rawArgument).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawArgument;
  return argument ? `${heading} - ${argument}` : heading;
}

/** Tool rows already sit inside a project-scoped thread, so its root label is redundant. */
function formatToolFilePath(path: string, workspaceRoot: string | undefined): string {
  return formatWorkspaceRelativePath(path, workspaceRoot, { includeWorkspaceLabel: false });
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles" | "itemType">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.itemType === "file_change" && (workEntry.changedFiles?.length ?? 0) > 0) {
    const [firstPath] = workEntry.changedFiles ?? [];
    if (!firstPath) return null;
    const displayPath = formatToolFilePath(firstPath, workspaceRoot);
    return workEntry.changedFiles!.length === 1
      ? displayPath
      : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
  }
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatToolFilePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

export function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

export function buildToolCallExpandedBody(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
  visibleLabel: string,
  viewedImagePath: string | null,
): string | null {
  const blocks: string[] = [];
  const seen = new Set<string>([visibleLabel.trim()]);
  const addBlock = (value: string | null | undefined) => {
    const text = value?.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    blocks.push(text);
  };
  if (workEntry.itemType === "dynamic_tool" && workEntry.toolData !== undefined) {
    const input =
      workEntry.structuredPayload?.type === "dynamic_tool"
        ? workEntry.structuredPayload.input
        : workEntry.toolData !== null &&
            typeof workEntry.toolData === "object" &&
            "input" in workEntry.toolData
          ? workEntry.toolData.input
          : undefined;
    if (input !== undefined) addBlock(`Tool input\n${JSON.stringify(input, null, 2)}`);
  }
  const command = workEntry.command?.trim();
  const raw = workEntryRawCommand(workEntry);
  if (command === visibleLabel.trim()) {
    seen.add(command);
  } else {
    addBlock(raw ?? command);
  }
  const toolArguments = buildToolArgumentLines(workEntry, workspaceRoot);
  addBlock(toolArguments);
  const askedQuestions = formatAskUserQuestionBody({
    toolName: workEntry.toolName,
    input: workEntry.toolInput,
  });
  addBlock(askedQuestions);
  // The adapters serialize a tool's whole input into `detail`, so once the
  // arguments are shown as fields the JSON restates them unreadably.
  const structuredInput = toolArguments !== null || askedQuestions !== null;
  const detail = workEntry.detail?.trim();
  if (
    detail !== viewedImagePath?.trim() &&
    !(structuredInput && detailIsSerializedInput(workEntry))
  ) {
    addBlock(detail);
  }
  const viewedImagePaths = new Set(
    viewedImagePath
      ? [viewedImagePath.trim(), formatToolFilePath(viewedImagePath, workspaceRoot)]
      : [],
  );
  const changedFiles = (workEntry.changedFiles ?? []).flatMap((filePath) => {
    const formattedPath = formatToolFilePath(filePath, workspaceRoot);
    return viewedImagePaths.has(filePath) ||
      viewedImagePaths.has(formattedPath) ||
      filePath.trim() === detail ||
      formattedPath === detail
      ? []
      : [formattedPath];
  });
  if (changedFiles.length > 0) {
    addBlock([...new Set(changedFiles)].join("\n"));
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

/** `Edit: {"file_path":…}` — the adapters' serialized-input detail format. */
function detailIsSerializedInput(
  workEntry: Pick<TimelineWorkEntry, "detail" | "toolName">,
): boolean {
  const detail = workEntry.detail?.trim();
  return (
    detail !== undefined &&
    workEntry.toolName !== undefined &&
    detail.startsWith(`${workEntry.toolName}: {`)
  );
}

const TOOL_ARGUMENT_LABELS: Readonly<Record<string, string>> = {
  file_path: "File",
  notebook_path: "Notebook",
  path: "Path",
  pattern: "Pattern",
  query: "Query",
  skill: "Skill",
  args: "Arguments",
  to: "To",
  subject: "Subject",
  url: "URL",
  offset: "From line",
  limit: "Lines",
};

/** Tool arguments as readable fields rather than one serialized blob. */
function buildToolArgumentLines(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
): string | null {
  const input = workEntry.toolInput;
  if (!input) {
    return null;
  }
  const lines: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      continue;
    }
    const label = TOOL_ARGUMENT_LABELS[key] ?? key;
    const rendered =
      typeof value === "string" &&
      (key === "file_path" || key === "notebook_path" || key === "path")
        ? formatToolFilePath(value, workspaceRoot)
        : value.toString();
    lines.push(`${label}: ${rendered}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export function buildCommandOutputBody(result: OrchestrationGetCommandOutputResult): string {
  if (result.status === "unavailable") {
    return "Command output is unavailable.";
  }

  const blocks: string[] = [];
  if (result.output) {
    blocks.push(result.output.trimEnd());
  } else if (result.stdout && result.stderr) {
    blocks.push(`stdout\n${result.stdout.trimEnd()}`);
    blocks.push(`stderr\n${result.stderr.trimEnd()}`);
  } else if (result.stdout) {
    blocks.push(result.stdout.trimEnd());
  } else if (result.stderr) {
    blocks.push(`stderr\n${result.stderr.trimEnd()}`);
  }
  if (result.exitCode !== null && result.exitCode !== 0) {
    blocks.push(`Process exited with code ${result.exitCode}`);
  }
  return blocks.length > 0 ? blocks.join("\n\n") : "No output";
}

export function workEntryIconName(workEntry: TimelineWorkEntry): WorkEntryIconName {
  if (workEntry.structuredPayload?.type === "notification") {
    if (workEntry.structuredPayload.outcome === "failed") return "circle-alert";
    const source = workEntry.structuredPayload.source;
    switch (source.kind) {
      case "subagent":
      case "delegated_task":
        return "bot";
      case "command":
        return "terminal";
      case "monitor":
        return "eye";
      case "background_task":
        return "zap";
      case "system":
        return "t3-code";
      default:
        source satisfies never;
        return "zap";
    }
  }
  if (workEntry.itemType === "user_input_request" || workEntry.itemType === "approval_request") {
    return "message-circle";
  }
  // Setup rows are named by the action that ran, in every lifecycle state:
  // the left icon says *which* action, the right indicator says how it ended.
  if (workEntry.sourceActivityKind?.startsWith("setup-script.")) {
    if (workEntry.setupScriptIcon) {
      return SETUP_ACTION_ICON_NAME[workEntry.setupScriptIcon];
    }
    // Historical rows do not carry configured identity, but they did run a command.
    return "terminal";
  }
  // The product-native browser family reads as a web surface, not a wrench.
  if (workEntry.toolName && isPreviewToolName(workEntry.toolName)) return "globe";

  if (workEntry.toolSurface) return workEntry.toolSurface;
  // The tool's own name beats itemType where the adapters' substring
  // classification gets it wrong (TaskCreate reads as a file write).
  switch (workEntry.toolName ? normalizeKnownToolName(workEntry.toolName) : undefined) {
    case "Read":
      return "eye";
    case "Grep":
    case "Glob":
    case "ToolSearch":
      return "wrench";
    case "SendMessage":
      return "message-circle";
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
      return "check";
    case "WebFetch":
    case "WebSearch":
      return "globe";
  }

  if (
    workEntry.structuredPayload?.type === "dynamic_tool" &&
    isJavaScriptReplTool(workEntry.structuredPayload.toolName)
  )
    return "code";
  const toolPresentation = resolveWorkEntryToolPresentation(workEntry);
  if (toolPresentation) return toolPresentation.icon;
  const action = toolGroupAction(workEntry);
  if (action !== "other") return toolGroupSummaryIconName(action);

  switch (workEntry.itemType) {
    case "dynamic_tool":
      return "wrench";
    case "subagent":
      return "bot";
  }

  return workToneIcon(workEntry.tone).iconName;
}

/** Compact reasoning keeps formulas while flattening other Markdown into label text. */
export function remarkThoughtPreview(fallback: string) {
  return (tree: Root) => {
    const children: RootContent[] = [];
    const append = (value: string) => {
      const last = children.at(-1);
      const text = value.replace(/\s+/g, " ");
      if (last?.type === "text") last.value = (last.value + text).replace(/\s+/g, " ");
      else children.push({ type: "text", value: text });
    };
    const visit = (node: Root | RootContent) => {
      if (node.type === "html" || node.type === "definition") return;
      if (node.type === "math" || node.type === "inlineMath") {
        children.push({
          type: "inlineMath",
          value: node.value,
          position: node.position,
          data: {
            hName: "code",
            hProperties: { className: ["language-math", "math-inline"] },
            hChildren: [{ type: "text", value: node.value }],
          },
        });
      } else if ("alt" in node) append(node.alt ?? "");
      else if ("value" in node) append(node.value);
      else if ("children" in node) {
        node.children.forEach((child, index) => {
          if (
            index &&
            ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(node.type)
          )
            append(" ");
          visit(child);
        });
      } else if (node.type === "break") append(" ");
    };
    visit(tree);
    const first = children[0];
    const last = children.at(-1);
    if (first?.type === "text") first.value = first.value.trimStart();
    if (last?.type === "text") last.value = last.value.trimEnd();
    tree.children = children.some((child) => child.type !== "text" || child.value)
      ? children
      : [{ type: "text", value: fallback }];
  };
}
