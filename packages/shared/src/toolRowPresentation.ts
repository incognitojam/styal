import type { ToolLifecycleItemType } from "@t3tools/contracts";

/**
 * Display vocabulary for tool rows in the chat timeline, shared by web, mobile
 * and the agent panel so every provider reads the same way.
 *
 * This is derived at RENDER time and must never be written back onto an
 * activity's `title`, `label` or `detail`. Those three fields are the identity
 * a tool row collapses on — the server drops superseded rows from snapshots
 * using the same triple (`toolLifecycleIdentity`), so a client that renamed
 * them would desync from the server's dedup and stop folding update rows into
 * their completions.
 *
 * It lives client-side rather than in the adapters because the fork rebases on
 * upstream: adapters and contracts are hot files, and persisted rows already
 * carry the generic titles, so only a render-time derivation fixes existing
 * history. If upstream ever emits a canonical presentation field, this module
 * should give way to it.
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
  /** `data.toolName`; Claude only — Codex and ACP rows never carry one. */
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
 * Memory files are ordinary writes, so only an exact `<root>/memory/<slug>.md`
 * shape counts. Matching any path containing "memory" would repeat the
 * substring guessing that mislabels rows in the first place.
 */
const MEMORY_PATH_PATTERN = /(?:^|\/)memory\/(?<slug>[^/]+)\.md$/u;

const MEMORY_INDEX_HEADING = "Updated memory index";

function memorySlug(path: string | undefined): string | undefined {
  return path ? MEMORY_PATH_PATTERN.exec(path)?.groups?.slug : undefined;
}

/** `mcp__t3-code__preview_snapshot` → `t3-code · preview_snapshot`. */
function mcpHeading(toolName: string): string | undefined {
  const match = /^mcp__(?<server>[^_]+(?:_[^_]+)*?)__(?<tool>.+)$/u.exec(toolName);
  const server = match?.groups?.server;
  const tool = match?.groups?.tool;
  return server && tool ? `${server} · ${tool}` : undefined;
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

interface PreviewToolSpec {
  readonly heading: string;
  readonly failedHeading: string;
  readonly argument?: (input: Record<string, unknown>) => ToolRowArgument | undefined;
}

/**
 * The T3 preview tools are a product-native browser family, so their rows get
 * a curated vocabulary instead of the generic `t3-code · preview_*` MCP form:
 * a verb for the action and only the argument that matters, with session noise
 * (`tabId`, `timeoutMs`, `open`/`show`) dropped.
 *
 * This table is the only list of the family; membership is derived from its
 * keys, so a tool added here is recognized everywhere without a second edit.
 */
const PREVIEW_TOOL_SPECS: Readonly<Record<string, PreviewToolSpec>> = {
  preview_status: {
    heading: "Checked preview status",
    failedHeading: "Failed to check preview status",
  },
  preview_open: {
    heading: "Opened preview",
    failedHeading: "Failed to open preview",
    argument: (input) => {
      const url = asTrimmedString(input?.url);
      return url ? { kind: "text", value: inline(url) } : undefined;
    },
  },
  preview_navigate: {
    heading: "Navigated preview",
    failedHeading: "Failed to navigate",
    argument: previewNavigateArgument,
  },
  preview_resize: {
    heading: "Resized preview",
    failedHeading: "Failed to resize preview",
    argument: previewResizeArgument,
  },
  preview_set_appearance: {
    heading: "Set preview appearance",
    failedHeading: "Failed to set appearance",
    argument: (input) => {
      const colorScheme = asTrimmedString(input?.colorScheme);
      return colorScheme ? { kind: "text", value: colorScheme } : undefined;
    },
  },
  preview_snapshot: { heading: "Inspected page", failedHeading: "Failed to inspect page" },
  preview_click: {
    heading: "Clicked",
    failedHeading: "Failed to click",
    argument: previewClickArgument,
  },
  preview_type: {
    heading: "Typed",
    failedHeading: "Failed to type",
    argument: previewTypeArgument,
  },
  preview_press: {
    heading: "Pressed",
    failedHeading: "Failed to press key",
    argument: previewPressArgument,
  },
  preview_scroll: {
    heading: "Scrolled",
    failedHeading: "Failed to scroll",
    argument: previewScrollArgument,
  },
  preview_evaluate: {
    heading: "Ran JS in preview",
    failedHeading: "Failed to run JS",
    argument: (input) => {
      const expression = asTrimmedString(input?.expression);
      return expression ? { kind: "text", value: inline(expression) } : undefined;
    },
  },
  preview_wait_for: {
    heading: "Waited for condition",
    failedHeading: "Failed to wait for condition",
    argument: previewWaitForArgument,
  },
  preview_recording_start: {
    heading: "Started recording preview",
    failedHeading: "Failed to start recording",
  },
  preview_recording_stop: {
    heading: "Stopped recording preview",
    failedHeading: "Failed to stop recording",
  },
};

const PREVIEW_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(PREVIEW_TOOL_SPECS));

/**
 * Every adapter registers this MCP server as `t3-code`, and the payload
 * projection gives providers that carry identity on the item a synthesized
 * `mcp__<server>__<tool>`, so the qualified name is the one form that reaches
 * presentation. Requiring it is what keeps this vocabulary — which describes
 * T3's browser specifically — off an unrelated server's `preview_*` tool.
 */
const QUALIFIED_PREVIEW_PREFIX = "mcp__t3-code__";

function previewToolNameOf(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith(QUALIFIED_PREVIEW_PREFIX)) {
    return undefined;
  }
  const tool = trimmed.slice(QUALIFIED_PREVIEW_PREFIX.length);
  return PREVIEW_TOOL_NAMES.has(tool) ? tool : undefined;
}

export function isPreviewToolName(value: string): boolean {
  return previewToolNameOf(value) !== undefined;
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
 * The whole prompt lives in this tool's input, so the generic row shows only
 * the tool's name. Name the act instead, and let the question itself be the
 * argument — or, when several were asked at once, their headers, since no one
 * question fits. The input is empty until the call completes, so the pending
 * row falls back to the singular phrasing.
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
  Edit: "file_change",
  Write: "file_change",
  NotebookEdit: "file_change",
  WebSearch: "web_search",
};

/**
 * Tools whose own name would mislead. Deliberately tiny: everything else names
 * itself, so tools added later (including MCP and user-defined ones) get a
 * correct row with no entry here.
 */
function overrideHeading(toolName: string, filePath: string | undefined): string | undefined {
  switch (toolName) {
    // Substring classification in the adapters reads "create"/"delete" as a
    // file mutation, so these arrive typed as file_change.
    case "TaskCreate":
      return "Created task";
    case "TaskUpdate":
      return "Updated task";
    case "TaskList":
      return "Listed tasks";
    case "Write":
    case "Edit": {
      const slug = memorySlug(filePath);
      if (!slug) {
        return undefined;
      }
      // MEMORY.md is the index every memory is listed in, not a memory.
      if (slug === "MEMORY") {
        return MEMORY_INDEX_HEADING;
      }
      return toolName === "Write" ? "Saved memory" : "Updated memory";
    }
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
  const filePath =
    asTrimmedString(input?.file_path) ??
    asTrimmedString(input?.notebook_path) ??
    asTrimmedString(input?.path);

  switch (toolName) {
    case "Bash":
    case "BashOutput":
      return context.command ? { kind: "command", value: context.command } : undefined;
    case "Read":
    case "NotebookEdit":
      return pathArgument(filePath, context.changedFiles);
    case "Write":
    case "Edit": {
      const slug = memorySlug(filePath);
      return slug ? { kind: "text", value: slug } : pathArgument(filePath, context.changedFiles);
    }
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
 * Titles that carry no information beyond "a tool ran". These are the three
 * adapters' fixed vocabularies — the strings that make one thread say
 * "Command run" and the next "Ran command" for the same action. A title
 * outside this set was chosen for a specific call (an ACP tool's own title, a
 * Codex `server · tool`) and outranks anything derived here.
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
  const filePath =
    asTrimmedString(toolInput?.file_path) ??
    asTrimmedString(toolInput?.notebook_path) ??
    asTrimmedString(toolInput?.path) ??
    changedFiles?.[0];

  const argument =
    (toolName
      ? argumentForToolName(toolName, { input: toolInput, command, detail, changedFiles })
      : undefined) ??
    // Codex and ACP rows have no tool name, so fall back to the shape of the
    // action. image_view's path arrives as the detail, which is why those rows
    // used to print an unshortened absolute path.
    argumentForItemType(itemType, { command, detail, changedFiles, filePath, toolName });

  // The product-native browser family outranks the generic MCP form: the
  // verbs are the vocabulary, and the failed heading is already chosen here
  // because the generic " … failed" suffix reads poorly after a past tense.
  if (rawToolName) {
    const previewTool = previewToolNameOf(rawToolName);
    const spec = previewTool ? PREVIEW_TOOL_SPECS[previewTool] : undefined;
    if (spec) {
      const previewArgument = spec.argument?.(toolInput ?? {});
      return {
        heading: input.failed ? spec.failedHeading : spec.heading,
        ...(previewArgument ? { argument: previewArgument } : {}),
      };
    }
  }

  if (toolName === ASK_USER_QUESTION_TOOL_NAME) {
    return askUserQuestionPresentation(toolInput, input.failed === true);
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

  const override = toolName ? overrideHeading(toolName, filePath) : undefined;
  if (override) {
    // The index's own name adds nothing next to the heading.
    const suppressArgument = override === MEMORY_INDEX_HEADING;
    return {
      heading: override,
      ...(argument && !suppressArgument ? { argument } : {}),
    };
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
  if (!presentation || !input.failed) {
    return presentation;
  }
  const toolName = asTrimmedString(input.toolName);
  if (toolName && isPreviewToolName(toolName)) {
    // Preview failures carry their own heading ("Failed to click").
    return presentation;
  }
  const normalizedToolName = toolName ? normalizeKnownToolName(toolName) : undefined;
  if (normalizedToolName === ASK_USER_QUESTION_TOOL_NAME) {
    // Already phrased for the cancelled case.
    return presentation;
  }
  const heading =
    input.itemType === "command_execution"
      ? "Command failed"
      : input.itemType === "file_change"
        ? normalizedToolName === "Write"
          ? "Write failed"
          : "Edit failed"
        : `${presentation.heading} failed`;
  return { ...presentation, heading };
}
