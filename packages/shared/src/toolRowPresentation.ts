import type { ToolLifecycleItemType } from "@t3tools/contracts";
import { resolveT3McpToolDefinition } from "./t3McpToolPresentation.ts";
import { styalToolHeading } from "./styalToolWording.ts";

import {
  isReportFindingsToolName,
  readReviewFindingsReport,
  reviewFindingsHeading,
} from "./reviewFindings.ts";

/**
 * Derived at render time only: `title`, `label` and `detail` are the identity the server dedups
 * tool rows on (`toolLifecycleIdentity`), so rewriting them would desync folding. Render time
 * also fixes persisted history, which already carries the generic titles.
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Collapses whitespace so a multi-line argument stays on the row's one line. */
function inline(value: string, maxLength = 120): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length <= maxLength
    ? collapsed
    : `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

export type ToolRowArgument =
  /** A filesystem path; callers format it relative to the workspace. */
  | { readonly kind: "path"; readonly value: string; readonly moreCount?: number }
  | { readonly kind: "command"; readonly value: string }
  | { readonly kind: "text"; readonly value: string };

export interface ToolRowPresentation {
  readonly heading: string;
  readonly argument?: ToolRowArgument | undefined;
}

export interface ToolRowPresentationInput {
  /** Canonical tool identity, including persisted provider spellings. */
  readonly toolName?: string | null | undefined;
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  /** The activity summary, i.e. the provider's own vocabulary. Last resort. */
  readonly label?: string | null | undefined;
  readonly detail?: string | null | undefined;
  /** `data.input`, whitelisted and length-capped by the server projection. */
  readonly input?: unknown;
  readonly command?: string | null | undefined;
  readonly changedFiles?: ReadonlyArray<string> | null | undefined;
  readonly failed?: boolean | undefined;
  /** The call never finished, such as a command a server restart killed. */
  readonly stopped?: boolean | undefined;
}

const KNOWN_TOOL_NAMES: Readonly<Record<string, string>> = {
  askuserquestion: "AskUserQuestion",
  bash: "Bash",
  bashoutput: "BashOutput",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  killshell: "KillShell",
  notebookedit: "NotebookEdit",
  powershell: "PowerShell",
  read: "Read",
  sendmessage: "SendMessage",
  taskcreate: "TaskCreate",
  tasklist: "TaskList",
  taskupdate: "TaskUpdate",
  toolsearch: "ToolSearch",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  write: "Write",
};

/** Gives provider-specific casing one stable vocabulary without renaming unknown tools. */
export function normalizeKnownToolName(value: string): string {
  const trimmed = value.trim();
  return KNOWN_TOOL_NAMES[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * Claude memories live under a project's own `.claude/projects` directory.
 * Repo files such as `docs/memory/design.md` remain ordinary file edits.
 */
const MEMORY_PATH_PATTERN = /(?:^|\/)\.claude\/projects\/[^/]+\/memory\/(?<slug>[^/]+)\.md$/u;

const MEMORY_INDEX_HEADING = "Updated memory index";

function memorySlug(path: string | undefined): string | undefined {
  return path ? MEMORY_PATH_PATTERN.exec(path)?.groups?.slug : undefined;
}

function toolFilePath(
  input: Record<string, unknown> | undefined,
  changedFiles: ReadonlyArray<string> | null | undefined,
): string | undefined {
  return (
    asTrimmedString(input?.file_path) ??
    asTrimmedString(input?.notebook_path) ??
    asTrimmedString(input?.path) ??
    asTrimmedString(changedFiles?.[0])
  );
}

/**
 * The memory file a Write or Edit call touched. Projected `file_change` items
 * name no tool, so an unnamed single-file change counts as a write too.
 */
export function memoryFileToolPath(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
  changedFiles?: ReadonlyArray<string> | null,
  itemType?: string | null,
): string | undefined {
  const normalizedToolName = toolName ? normalizeKnownToolName(toolName) : undefined;
  const writesFile = normalizedToolName
    ? normalizedToolName === "Write" || normalizedToolName === "Edit"
    : itemType === "file_change" && (changedFiles?.length ?? 0) <= 1;
  if (!writesFile) return undefined;
  const path = toolFilePath(input, changedFiles);
  return memorySlug(path) ? path : undefined;
}

/** The memory file, or memory index, a Read call opened. */
export function memoryFileReadPath(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!toolName || normalizeKnownToolName(toolName) !== "Read") return undefined;
  const path = toolFilePath(input, undefined);
  return memorySlug(path) ? path : undefined;
}

export function memoryFileToolKind(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
  changedFiles?: ReadonlyArray<string> | null,
  itemType?: string | null,
): "memory" | "index" | undefined {
  const slug = memorySlug(memoryFileToolPath(toolName, input, changedFiles, itemType));
  return slug === "MEMORY" ? "index" : slug ? "memory" : undefined;
}

/** styal's own MCP server, under its current and pre-rename names. */
const PRODUCT_MCP_SERVERS: ReadonlySet<string> = new Set(["styal", "t3-code", "t3_code", "t3code"]);

/**
 * Adapters name MCP calls `mcp__<server>__<tool>`. Persisted activity also
 * holds V1's `server · tool` and, for styal's own server only, Codex's
 * `server.tool`; a bare dotted name is too ambiguous to split generally.
 */
function mcpToolNameParts(
  toolName: string,
): { readonly server: string; readonly tool: string } | undefined {
  const match =
    /^mcp__(?<server>[^_]+(?:_[^_]+)*?)__(?<tool>.+)$/iu.exec(toolName) ??
    /^(?<server>[^\s·]+) · (?<tool>\S+)$/iu.exec(toolName) ??
    /^(?<server>styal|t3-code|t3_code|t3code)[._](?<tool>[^.\s]+)$/iu.exec(toolName);
  const server = match?.groups?.server;
  const tool = match?.groups?.tool;
  return server && tool ? { server, tool } : undefined;
}

/** `mcp__styal__preview_snapshot` → `styal · preview_snapshot`. */
function mcpHeading(toolName: string): string | undefined {
  const parts = mcpToolNameParts(toolName);
  if (!parts) {
    return undefined;
  }
  const server = PRODUCT_MCP_SERVERS.has(parts.server.toLowerCase()) ? "styal" : parts.server;
  return `${server} · ${parts.tool}`;
}

function previewNavigateArgument(input: Record<string, unknown>): ToolRowArgument | undefined {
  const url = asTrimmedString(input?.url);
  if (url) {
    return { kind: "text", value: inline(url) };
  }
  const target = asRecord(input?.target);
  if (target?.kind === "url") {
    const targetUrl = asTrimmedString(target.url);
    return targetUrl ? { kind: "text", value: inline(targetUrl) } : undefined;
  }
  if (target?.kind === "environment-port" && typeof target.port === "number") {
    // The path is the interesting half of a dev-server hop, so keep it.
    const path = asTrimmedString(target.path) ?? "";
    const suffix = path && !path.startsWith("/") ? `/${path}` : path;
    return { kind: "text", value: inline(`dev server :${target.port.toString()}${suffix}`) };
  }
  return undefined;
}

function previewResizeArgument(input: Record<string, unknown>): ToolRowArgument | undefined {
  if (typeof input?.width === "number" && typeof input?.height === "number") {
    return { kind: "text", value: `${input.width}×${input.height}` };
  }
  const preset = asTrimmedString(input?.preset);
  if (preset) {
    const orientation = asTrimmedString(input?.orientation);
    return orientation && orientation !== "portrait"
      ? { kind: "text", value: `${preset} ${orientation}` }
      : { kind: "text", value: preset };
  }
  return input?.mode === "fill" ? { kind: "text", value: "fit preview panel" } : undefined;
}

function previewClickArgument(input: Record<string, unknown>): ToolRowArgument | undefined {
  const target = asTrimmedString(input?.locator) ?? asTrimmedString(input?.selector);
  if (target) {
    return { kind: "text", value: inline(target) };
  }
  if (typeof input?.x === "number" && typeof input?.y === "number") {
    return { kind: "text", value: `${input.x}, ${input.y}` };
  }
  return undefined;
}

function previewTypeArgument(input: Record<string, unknown>): ToolRowArgument | undefined {
  const text = asTrimmedString(input?.text);
  return text ? { kind: "text", value: inline(`“${text}”`) } : undefined;
}

function previewPressArgument(input: Record<string, unknown>): ToolRowArgument | undefined {
  const key = asTrimmedString(input?.key);
  if (!key) {
    return undefined;
  }
  const modifiers = Array.isArray(input?.modifiers)
    ? input.modifiers.filter((m): m is string => typeof m === "string")
    : [];
  return modifiers.length > 0
    ? { kind: "text", value: `${modifiers.join("+")}+${key}` }
    : { kind: "text", value: key };
}

function previewScrollArgument(input: Record<string, unknown>): ToolRowArgument | undefined {
  const parts: string[] = [];
  const deltaY = typeof input?.deltaY === "number" ? input.deltaY : 0;
  const deltaX = typeof input?.deltaX === "number" ? input.deltaX : 0;
  if (deltaY !== 0) {
    parts.push(deltaY > 0 ? `down ${deltaY.toString()}px` : `up ${(-deltaY).toString()}px`);
  }
  if (deltaX !== 0) {
    parts.push(deltaX > 0 ? `right ${deltaX.toString()}px` : `left ${(-deltaX).toString()}px`);
  }
  return parts.length > 0 ? { kind: "text", value: parts.join(" ") } : undefined;
}

function previewWaitForArgument(input: Record<string, unknown>): ToolRowArgument | undefined {
  const condition = asTrimmedString(input?.text) ?? asTrimmedString(input?.urlIncludes);
  if (condition) {
    return { kind: "text", value: inline(condition) };
  }
  const target = asTrimmedString(input?.locator) ?? asTrimmedString(input?.selector);
  return target ? { kind: "text", value: inline(target) } : undefined;
}

/** Only the useful argument is fork-specific; headings come from the shared inventory. */
export const STYAL_PREVIEW_TOOL_ARGUMENTS: Readonly<
  Record<string, (input: Record<string, unknown>) => ToolRowArgument | undefined>
> = {
  preview_open: (input) => {
    const url = asTrimmedString(input.url);
    return url ? { kind: "text", value: inline(url) } : undefined;
  },
  preview_navigate: previewNavigateArgument,
  preview_resize: previewResizeArgument,
  preview_set_appearance: (input) => {
    const colorScheme = asTrimmedString(input.colorScheme);
    return colorScheme ? { kind: "text", value: colorScheme } : undefined;
  },
  preview_click: previewClickArgument,
  preview_type: previewTypeArgument,
  preview_press: previewPressArgument,
  preview_scroll: previewScrollArgument,
  preview_evaluate: (input) => {
    const expression = asTrimmedString(input.expression);
    return expression ? { kind: "text", value: inline(expression) } : undefined;
  },
  preview_wait_for: previewWaitForArgument,
};

function productToolDefinition(value: string) {
  const parts = mcpToolNameParts(value.trim());
  return parts && PRODUCT_MCP_SERVERS.has(parts.server.toLowerCase())
    ? resolveT3McpToolDefinition(value)
    : null;
}

/** Bare tool names cannot establish that a call came from styal's browser. */
export function isPreviewToolName(value: string): boolean {
  return productToolDefinition(value)?.icon === "browser";
}

const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

interface AskedQuestion {
  readonly question: string | undefined;
  readonly header: string | undefined;
  readonly options: ReadonlyArray<string>;
}

function askedQuestions(input: Record<string, unknown> | undefined): ReadonlyArray<AskedQuestion> {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  return questions.flatMap((entry) => {
    const record = asRecord(entry);
    const question = asTrimmedString(record?.question);
    const header = asTrimmedString(record?.header);
    if (!question && !header) {
      return [];
    }
    const options = (Array.isArray(record?.options) ? record.options : []).flatMap((option) => {
      const label = asTrimmedString(asRecord(option)?.label);
      return label ? [label] : [];
    });
    return [{ question, header, options }];
  });
}

/**
 * The generic row would show only the tool's name, so the question (or the headers of several)
 * is the argument. The input is empty until the call completes, so the pending row uses the
 * singular phrasing.
 */
function askUserQuestionPresentation(
  input: Record<string, unknown> | undefined,
  failed: boolean,
): ToolRowPresentation {
  const questions = askedQuestions(input);
  const many = questions.length > 1;
  const heading = failed
    ? many
      ? "Questions cancelled"
      : "Question cancelled"
    : many
      ? `Asked ${questions.length.toString()} questions`
      : "Asked a question";
  const summary = many
    ? questions
        .map((entry) => entry.header ?? entry.question)
        .filter((value): value is string => value !== undefined)
        .join(" · ")
    : (questions[0]?.question ?? questions[0]?.header);
  const argument = textArgument(summary);
  return { heading, ...(argument ? { argument } : {}) };
}

/**
 * The asked questions as readable text for a row's expanded body, in place of
 * the serialized input. Option labels are what the answer was chosen from;
 * their descriptions are prose that belongs in the picker, not the work log.
 */
export function formatAskUserQuestionBody(input: {
  readonly toolName?: string | null | undefined;
  readonly input?: unknown;
}): string | null {
  const toolName = asTrimmedString(input.toolName);
  if (!toolName || normalizeKnownToolName(toolName) !== ASK_USER_QUESTION_TOOL_NAME) {
    return null;
  }
  const questions = askedQuestions(asRecord(input.input));
  if (questions.length === 0) {
    return null;
  }
  return questions
    .map((entry) => {
      const lines = [entry.question ?? entry.header!];
      if (entry.header && entry.question) {
        lines.unshift(entry.header);
      }
      for (const option of entry.options) {
        lines.push(`  · ${option}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * `select:a,b,c` is ToolSearch's exact-name form and reads as noise in full;
 * show the names themselves. Free-text queries pass through.
 */
function toolSearchArgument(query: string): string {
  const selection = /^select:(?<names>.+)$/su.exec(query)?.groups?.names;
  if (!selection) {
    return query;
  }
  const names = selection
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/u, ""));
  if (names.length === 0) {
    return query;
  }
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? `${shown} +${names.length - 2} more` : shown;
}

function pathArgument(
  path: string | undefined,
  changedFiles: ReadonlyArray<string> | null | undefined,
): ToolRowArgument | undefined {
  const value = path ?? changedFiles?.[0];
  if (!value) {
    return undefined;
  }
  const moreCount = Math.max((changedFiles?.length ?? 0) - 1, 0);
  return moreCount > 0 ? { kind: "path", value, moreCount } : { kind: "path", value };
}

function textArgument(value: string | undefined): ToolRowArgument | undefined {
  const text = value ? inline(value) : undefined;
  return text ? { kind: "text", value: text } : undefined;
}

/**
 * Verbs for the item types providers actually model. Both Claude and Codex
 * reach these, which is what makes a mixed thread read consistently — today
 * the same action says "Command run" on one row and "Ran command" on the next.
 */
function verbForItemType(
  itemType: ToolLifecycleItemType,
  input: {
    readonly toolName: string | undefined;
    readonly changedFileCount: number;
  },
): string | undefined {
  switch (itemType) {
    case "command_execution":
      return "Ran command";
    case "file_change": {
      if (input.toolName === "NotebookEdit") {
        return "Edited notebook";
      }
      if (input.changedFileCount > 1) {
        return `Edited ${input.changedFileCount.toString()} files`;
      }
      return input.toolName === "Write" ? "Wrote file" : "Edited file";
    }
    case "image_view":
      return "Viewed image";
    case "web_search":
      return "Searched web";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "mcp_tool_call":
    case "dynamic_tool_call":
      return undefined;
  }
}

/**
 * Item types for the few tools whose action is unambiguous, so callers holding
 * only a tool name — the agents panel's `lastToolName` — get the same verb the
 * timeline shows instead of a bare "Bash".
 */
const ITEM_TYPE_BY_TOOL_NAME: Readonly<Record<string, ToolLifecycleItemType>> = {
  Bash: "command_execution",
  BashOutput: "command_execution",
  KillShell: "command_execution",
  PowerShell: "command_execution",
  Edit: "file_change",
  Write: "file_change",
  NotebookEdit: "file_change",
  WebSearch: "web_search",
};

/**
 * ACP adapters type every search as `web_search`, including greps of the
 * workspace; only those name the directory they searched.
 */
export function isWorkspaceSearchInput(input: Record<string, unknown> | undefined): boolean {
  return asTrimmedString(input?.directory_path) !== undefined;
}

/**
 * Tools whose own name would mislead. Deliberately tiny: everything else names
 * itself, so tools added later (including MCP and user-defined ones) get a
 * correct row with no entry here.
 */
function overrideHeading(toolName: string): string | undefined {
  switch (toolName) {
    // Substring classification in the adapters reads "create"/"delete" as a
    // file mutation, so these arrive typed as file_change.
    case "TaskCreate":
      return "Created task";
    case "TaskUpdate":
      return "Updated task";
    case "TaskList":
      return "Listed tasks";
    // Named like ACP's page fetches rather than by the tool's identifier.
    case "WebFetch":
      return "Fetched page";
    default:
      return undefined;
  }
}

function argumentForToolName(
  toolName: string,
  context: {
    readonly input: Record<string, unknown> | undefined;
    readonly command: string | undefined;
    readonly detail: string | undefined;
    readonly changedFiles: ReadonlyArray<string> | null | undefined;
  },
): ToolRowArgument | undefined {
  const { input } = context;
  const filePath = toolFilePath(input, context.changedFiles);

  switch (toolName) {
    case "Bash":
    case "BashOutput":
    case "PowerShell":
      return context.command ? { kind: "command", value: context.command } : undefined;
    case "Read":
    case "NotebookEdit":
    case "Write":
    case "Edit":
      return pathArgument(filePath, context.changedFiles);
    case "Glob":
    case "Grep":
      return textArgument(asTrimmedString(input?.pattern) ?? asTrimmedString(input?.query));
    case "ToolSearch": {
      const query = asTrimmedString(input?.query);
      return query ? { kind: "text", value: inline(toolSearchArgument(query)) } : undefined;
    }
    case "Skill": {
      const skill = asTrimmedString(input?.skill);
      const args = asTrimmedString(input?.args);
      if (!skill) {
        return undefined;
      }
      return { kind: "text", value: args ? inline(`${skill} · ${args}`) : skill };
    }
    case "SendMessage": {
      const to = asTrimmedString(input?.to);
      const summary = asTrimmedString(input?.summary);
      if (!to) {
        return textArgument(summary);
      }
      return { kind: "text", value: inline(summary ? `→ ${to} · ${summary}` : `→ ${to}`) };
    }
    case "TaskCreate":
    case "TaskUpdate":
      return textArgument(asTrimmedString(input?.subject) ?? asTrimmedString(input?.description));
    case "WebFetch":
    case "WebSearch":
      return textArgument(asTrimmedString(input?.url) ?? asTrimmedString(input?.query));
    default:
      return undefined;
  }
}

/**
 * `Edit: {"file_path":…}` — the adapters serialize a whole tool input into
 * `detail`. It restates the row and is never worth showing beside it.
 */
function isSerializedInputDetail(detail: string, toolName: string | undefined): boolean {
  return toolName !== undefined && detail.startsWith(`${toolName}: {`);
}

/** MCP servers name their own arguments, so show them as compact pairs. */
function mcpArgument(input: Record<string, unknown> | undefined): ToolRowArgument | undefined {
  if (!input) {
    return undefined;
  }
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      continue;
    }
    pairs.push(`${key}: ${value.toString()}`);
    if (pairs.length === 2) {
      break;
    }
  }
  return pairs.length > 0 ? { kind: "text", value: inline(pairs.join(" · ")) } : undefined;
}

function argumentForItemType(
  itemType: ToolLifecycleItemType | undefined,
  context: {
    readonly command: string | undefined;
    readonly detail: string | undefined;
    readonly changedFiles: ReadonlyArray<string> | null | undefined;
    readonly filePath: string | undefined;
    readonly toolName: string | undefined;
  },
): ToolRowArgument | undefined {
  switch (itemType) {
    case "command_execution":
      return context.command ? { kind: "command", value: context.command } : undefined;
    case "file_change":
      return pathArgument(context.filePath, context.changedFiles);
    case "image_view": {
      const path = context.filePath ?? context.detail;
      return path ? { kind: "path", value: path } : undefined;
    }
    default: {
      // Rows can carry changed files without being typed as a file change.
      const path = pathArgument(context.filePath, context.changedFiles);
      if (path) {
        return path;
      }
      // Providers without a tool name (Codex, ACP) often put the only useful
      // text in the detail.
      const detail = context.detail;
      return detail && !isSerializedInputDetail(detail, context.toolName)
        ? textArgument(detail)
        : undefined;
    }
  }
}

/**
 * The adapters' fixed titles that say only "a tool ran". A title outside this set was chosen
 * for a specific call and outranks anything derived here.
 */
const GENERIC_LABELS = new Set([
  "tool",
  "item",
  "tool call",
  "tool updated",
  "dynamic tool call",
  "mcp tool call",
  "subagent task",
  "command run",
  "ran command",
  "terminal",
  "file change",
  "changed files",
  "read file",
  "searched files",
  "image view",
  "web search",
]);

function cleanLabel(label: string | undefined): string | undefined {
  const stripped = label?.replace(/\s+(?:started|complete|completed)\s*$/iu, "").trim();
  if (!stripped) {
    return undefined;
  }
  return GENERIC_LABELS.has(stripped.toLowerCase()) ? undefined : stripped;
}

function deriveBaseToolRowPresentation(
  input: ToolRowPresentationInput,
): ToolRowPresentation | undefined {
  const rawToolName = asTrimmedString(input.toolName);
  const toolName = rawToolName ? normalizeKnownToolName(rawToolName) : undefined;
  const itemType =
    input.itemType ?? (toolName ? ITEM_TYPE_BY_TOOL_NAME[toolName] : undefined) ?? undefined;
  const toolInput = asRecord(input.input);
  const command = asTrimmedString(input.command);
  const detail = asTrimmedString(input.detail);
  const changedFiles = input.changedFiles ?? undefined;
  const filePath = toolFilePath(toolInput, changedFiles);

  const argument =
    (toolName
      ? argumentForToolName(toolName, { input: toolInput, command, detail, changedFiles })
      : undefined) ??
    // Codex and ACP rows have no tool name, so fall back to the shape of the
    // action. image_view's path arrives as the detail, which is why those rows
    // used to print an unshortened absolute path.
    argumentForItemType(itemType, { command, detail, changedFiles, filePath, toolName });

  if (rawToolName) {
    const definition = productToolDefinition(rawToolName);
    if (definition) {
      const name = mcpToolNameParts(rawToolName)?.tool;
      const previewArgument = name
        ? STYAL_PREVIEW_TOOL_ARGUMENTS[name]?.(toolInput ?? {})
        : undefined;
      const toolArgument = definition.icon === "browser" ? previewArgument : mcpArgument(toolInput);
      return {
        heading: styalToolHeading(
          definition,
          input.failed ? "failed" : input.stopped ? "stopped" : "completed",
        ),
        ...(toolArgument ? { argument: toolArgument } : {}),
      };
    }
  }

  // ACP rows name no tool and arrive as `web_search` for page fetches and
  // workspace greps too, titled "Searched files"; the input says which ran.
  if (!toolName && itemType === "web_search") {
    const url = asTrimmedString(toolInput?.url);
    if (url) {
      return { heading: "Fetched page", argument: { kind: "text", value: url } };
    }
    if (isWorkspaceSearchInput(toolInput)) {
      return { heading: "Searched code", ...(argument ? { argument } : {}) };
    }
  }

  if (toolName === ASK_USER_QUESTION_TOOL_NAME) {
    return askUserQuestionPresentation(toolInput, input.failed === true);
  }

  if (isReportFindingsToolName(toolName)) {
    // A rejected report is retried by the agent; the accepted one renders as
    // a findings card, so these headings only show on the rows themselves.
    if (input.failed) {
      return { heading: "Findings report rejected" };
    }
    const report = readReviewFindingsReport(toolInput);
    return { heading: report ? reviewFindingsHeading(report) : "Reported findings" };
  }

  // MCP names itself best: the server is the useful half, and Codex already
  // renders `server · tool` this way.
  if (toolName) {
    const mcp = mcpHeading(toolName);
    if (mcp) {
      // The heading already carries the server and tool, so the adapters'
      // `mcp__server__tool: {json}` detail is pure restatement.
      const mcpArguments = mcpArgument(toolInput) ?? argument;
      return { heading: mcp, ...(mcpArguments ? { argument: mcpArguments } : {}) };
    }
  }

  const memoryPath = memoryFileToolPath(toolName, toolInput, changedFiles, itemType);
  const memory = memorySlug(memoryPath);
  if (memory) {
    // MEMORY.md is the index every memory is listed in, not a memory, and its
    // own name adds nothing next to the heading.
    if (memory === "MEMORY") {
      return { heading: MEMORY_INDEX_HEADING };
    }
    return {
      heading: toolName === "Write" ? "Saved memory" : "Updated memory",
      argument: { kind: "text", value: memory },
    };
  }

  // Reads stay file reads in group and fold counts; only the row names the
  // memory instead of printing its path under the projects directory.
  const readMemory = memorySlug(memoryFileReadPath(toolName, toolInput));
  if (readMemory === "MEMORY") return { heading: "Read memory index" };
  if (readMemory) {
    return { heading: "Read memory", argument: { kind: "text", value: readMemory } };
  }

  const override = toolName ? overrideHeading(toolName) : undefined;
  if (override) {
    return { heading: override, ...(argument ? { argument } : {}) };
  }

  // ACP rows name no tool: `deriveToolActivityPresentation` titles their reads
  // "Read file" and carries the path as the detail, so present them as Read.
  if (!toolName && asTrimmedString(input.label)?.toLowerCase() === "read file") {
    return { heading: "Read", ...(detail ? { argument: { kind: "path", value: detail } } : {}) };
  }

  // A title the provider chose for this specific call says more than any verb
  // derived from its item type.
  const cleanedLabel = cleanLabel(asTrimmedString(input.label));
  // OpenCode uses the raw tool name as its lifecycle title (`edit`, `bash`,
  // and so on). That is identity, not a call-specific description, so let the
  // canonical item-type verb win just as it does for Claude and Codex.
  const specificLabel =
    cleanedLabel && cleanedLabel.toLowerCase() !== toolName?.toLowerCase()
      ? cleanedLabel
      : undefined;
  if (specificLabel) {
    return { heading: specificLabel, ...(argument ? { argument } : {}) };
  }

  const verb = itemType
    ? verbForItemType(itemType, {
        toolName,
        changedFileCount: changedFiles?.length ?? 0,
      })
    : undefined;
  if (verb) {
    return { heading: verb, ...(argument ? { argument } : {}) };
  }

  // The unknown-tool bucket: the tool's own name beats "Tool call", and needs
  // no table entry to stay correct as tools are added.
  if (toolName) {
    return { heading: toolName, ...(argument ? { argument } : {}) };
  }

  return undefined;
}

export function deriveToolRowPresentation(
  input: ToolRowPresentationInput,
): ToolRowPresentation | undefined {
  const presentation = deriveBaseToolRowPresentation(input);
  const outcome = input.failed ? "failed" : input.stopped ? "stopped" : undefined;
  if (!presentation || outcome === undefined) {
    return presentation;
  }
  const toolName = asTrimmedString(input.toolName);
  if (toolName && productToolDefinition(toolName)) {
    // The shared inventory already phrased the lifecycle outcome.
    return presentation;
  }
  const normalizedToolName = toolName ? normalizeKnownToolName(toolName) : undefined;
  if (
    outcome === "failed" &&
    (normalizedToolName === ASK_USER_QUESTION_TOOL_NAME ||
      isReportFindingsToolName(normalizedToolName))
  ) {
    // Already phrased for the failed case.
    return presentation;
  }
  const heading =
    input.itemType === "command_execution"
      ? `Command ${outcome}`
      : input.itemType === "file_change"
        ? normalizedToolName === "Write"
          ? `Write ${outcome}`
          : `Edit ${outcome}`
        : `${presentation.heading} ${outcome}`;
  return { ...presentation, heading };
}
