import type { ToolLifecycleItemType } from "@t3tools/contracts";

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

export interface ToolFileChangeLineStat {
  readonly additions: number;
  readonly deletions: number;
}

function splitLines(value: string): string[] {
  if (value.length === 0) {
    return [];
  }
  const lines = value.split(/\r\n|\r|\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function lineChangeStat(oldValue: string, newValue: string): ToolFileChangeLineStat {
  const oldLines = splitLines(oldValue);
  const newLines = splitLines(newValue);
  if (oldLines.length * newLines.length > 40_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const row = new Uint32Array(newLines.length + 1);
  for (const oldLine of oldLines) {
    let diagonal = 0;
    for (let index = 1; index <= newLines.length; index += 1) {
      const above = row[index] ?? 0;
      row[index] =
        oldLine === newLines[index - 1] ? diagonal + 1 : Math.max(row[index - 1] ?? 0, above);
      diagonal = above;
    }
  }
  const unchanged = row[newLines.length] ?? 0;
  return {
    additions: newLines.length - unchanged,
    deletions: oldLines.length - unchanged,
  };
}

function codexFileChangeLineStat(
  item: Record<string, unknown> | undefined,
): ToolFileChangeLineStat | undefined {
  if (!Array.isArray(item?.changes)) {
    return undefined;
  }
  let additions = 0;
  let deletions = 0;
  let foundChange = false;
  for (const value of item.changes) {
    const change = asRecord(value);
    const kind = asRecord(change?.kind)?.type;
    if (typeof change?.diff !== "string" || typeof kind !== "string") {
      continue;
    }
    foundChange = true;
    if (kind === "add" || kind === "delete") {
      const lineCount = splitLines(change.diff).length;
      additions += kind === "add" ? lineCount : 0;
      deletions += kind === "delete" ? lineCount : 0;
      continue;
    }
    if (kind === "update") {
      for (const line of splitLines(change.diff)) {
        additions += line.startsWith("+") && !line.startsWith("+++ ") ? 1 : 0;
        deletions += line.startsWith("-") && !line.startsWith("--- ") ? 1 : 0;
      }
    }
  }
  return foundChange ? { additions, deletions } : undefined;
}

/** Derives display-only line counts from provider file-change payloads. */
export function deriveToolFileChangeLineStat(data: unknown): ToolFileChangeLineStat | undefined {
  const record = asRecord(data);
  const projected = asRecord(record?.fileChangeStat);
  const projectedAdditions = projected?.additions;
  const projectedDeletions = projected?.deletions;
  if (
    typeof projectedAdditions === "number" &&
    Number.isInteger(projectedAdditions) &&
    projectedAdditions >= 0 &&
    typeof projectedDeletions === "number" &&
    Number.isInteger(projectedDeletions) &&
    projectedDeletions >= 0
  ) {
    return { additions: projectedAdditions, deletions: projectedDeletions };
  }

  const item = asRecord(record?.item);
  const input = asRecord(record?.input) ?? asRecord(item?.input);
  const editStat =
    typeof input?.old_string === "string" &&
    typeof input.new_string === "string" &&
    input.replace_all !== true
      ? lineChangeStat(input.old_string, input.new_string)
      : undefined;
  return editStat ?? codexFileChangeLineStat(item);
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const entry of value) {
    const part = asTrimmedString(entry);
    if (part !== undefined) {
      parts.push(part);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function stripTrailingExitCode(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code \d+>)\s*$/iu.exec(trimmed);
  const output = match?.groups?.output?.trim() ?? trimmed;
  return output.length > 0 ? output : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const backtickMatch = /`([^`]+)`/u.exec(title);
  return backtickMatch?.[1]?.trim() || undefined;
}

function extractToolCommand(data: Record<string, unknown> | undefined, title: string | undefined) {
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const rawInput = asRecord(data?.rawInput);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
    normalizeCommandValue(rawInput?.command),
  ];
  const direct = candidates.find((candidate) => candidate !== undefined);
  if (direct) {
    return direct;
  }
  const executable = asTrimmedString(rawInput?.executable);
  const args = normalizeCommandValue(rawInput?.args);
  if (executable && args) {
    return `${executable} ${args}`;
  }
  if (executable) {
    return executable;
  }
  return extractCommandFromTitle(title);
}

function unwrapLiteralShellWord(value: string): string | undefined {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const contents = value.slice(1, -1);
    // Keep this display heuristic literal-only. Expansions can resolve to a
    // different file than the text shown in the command.
    if (/[`$\\]/u.test(contents)) {
      return undefined;
    }
    return contents;
  }
  if (/['"`$\\;&|<>]/u.test(value)) {
    return undefined;
  }
  return value;
}

export interface CommandFileReadPresentation extends ToolActivityPresentation {
  readonly path: string;
}

/**
 * Recognizes the narrow `sed -n '<lines>p' <file>` form agents commonly use
 * as a read primitive. More general sed programs stay command executions.
 */
export function deriveCommandFileReadPresentation(
  command: string | null | undefined,
): CommandFileReadPresentation | undefined {
  const normalized = asTrimmedString(command);
  if (!normalized) {
    return undefined;
  }
  const commandBody = normalized.replace(/^(?:bash|shell|terminal):\s+/iu, "");
  const match =
    /^(?<executable>(?:[^\s]*[/\\])?sed)\s+-n\s+(?<program>'[^']*'|"[^"]*"|[^\s]+)\s+(?:--\s+)?(?<path>'[^']*'|"[^"]*"|[^\s]+)\s*$/u.exec(
      commandBody,
    );
  const program = match?.groups?.program ? unwrapLiteralShellWord(match.groups.program) : undefined;
  const filePath = match?.groups?.path ? unwrapLiteralShellWord(match.groups.path) : undefined;
  if (!program || !/^\d+(?:,\d+)?p$/u.test(program) || !filePath || filePath === "-") {
    return undefined;
  }

  return {
    summary: "Read file",
    detail: filePath,
    path: filePath,
  };
}

function maybePathLike(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    /\.(?:[a-z0-9]{1,12})$/iu.test(value)
  ) {
    return value;
  }
  return undefined;
}

function collectPaths(value: unknown, paths: string[], seen: Set<string>, depth: number): void {
  if (depth > 4 || paths.length >= 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, paths, seen, depth + 1);
      if (paths.length >= 8) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
    const candidate = maybePathLike(asTrimmedString(record[key]));
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    paths.push(candidate);
    if (paths.length >= 8) {
      return;
    }
  }
  for (const nestedKey of ["locations", "item", "input", "result", "rawInput", "data", "changes"]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectPaths(record[nestedKey], paths, seen, depth + 1);
    if (paths.length >= 8) {
      return;
    }
  }
}

function extractPrimaryPath(data: Record<string, unknown> | undefined): string | undefined {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths[0];
}

function normalizeEquivalentValue(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/\s+/gu, " ")
    .replace(/\s+(?:complete|completed|started)\s*$/iu, "")
    .trim();
}

function isEquivalent(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeEquivalentValue(left)?.toLowerCase();
  const normalizedRight = normalizeEquivalentValue(right)?.toLowerCase();
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

function classifyToolAction(input: {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): "command" | "read" | "file_change" | "search" | "other" {
  const itemType = input.itemType ?? undefined;
  const kind = asTrimmedString(input.data?.kind)?.toLowerCase();
  const title = asTrimmedString(input.title)?.toLowerCase();
  if (itemType === "command_execution" || kind === "execute" || title === "terminal") {
    return "command";
  }
  if (kind === "read" || title === "read file") {
    return "read";
  }
  if (
    itemType === "file_change" ||
    kind === "edit" ||
    kind === "move" ||
    kind === "delete" ||
    kind === "write"
  ) {
    return "file_change";
  }
  if (itemType === "web_search" || kind === "search" || title === "find" || title === "grep") {
    return "search";
  }
  return "other";
}

export interface ToolActivityPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly fallbackSummary?: string | null | undefined;
}

export interface ToolActivityPresentation {
  readonly summary: string;
  readonly detail?: string | undefined;
}

export function deriveToolActivityPresentation(
  input: ToolActivityPresentationInput,
): ToolActivityPresentation {
  const title = asTrimmedString(input.title);
  const detail = stripTrailingExitCode(asTrimmedString(input.detail));
  const fallbackSummary = asTrimmedString(input.fallbackSummary) ?? "Tool";
  const data = asRecord(input.data);
  const command = extractToolCommand(data, title);
  const primaryPath = extractPrimaryPath(data);
  const action = classifyToolAction({
    itemType: input.itemType,
    title,
    data,
  });

  if (action === "command") {
    const fileRead = deriveCommandFileReadPresentation(command);
    if (fileRead) {
      return fileRead;
    }
    return {
      summary: "Ran command",
      ...(command ? { detail: command } : {}),
    };
  }

  if (action === "read") {
    if (primaryPath) {
      return {
        summary: "Read file",
        detail: primaryPath,
      };
    }
    return {
      summary: "Read file",
    };
  }

  if (action === "file_change") {
    return {
      summary: "Changed files",
      ...(primaryPath ? { detail: primaryPath } : {}),
    };
  }

  if (action === "search") {
    const query =
      asTrimmedString(asRecord(data?.rawInput)?.query) ??
      asTrimmedString(asRecord(data?.rawInput)?.pattern) ??
      asTrimmedString(asRecord(data?.rawInput)?.searchTerm);
    return {
      summary: "Searched files",
      ...(query ? { detail: query } : {}),
    };
  }

  if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
    return {
      summary: title ?? fallbackSummary,
      detail,
    };
  }

  return {
    summary: title ?? fallbackSummary,
  };
}
