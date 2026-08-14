function splitPathAndPosition(value: string): {
  readonly path: string;
  readonly line: string | undefined;
  readonly column: string | undefined;
} {
  let path = value;
  let column: string | undefined;
  let line: string | undefined;

  const columnMatch = path.match(/:(\d+)$/u);
  if (!columnMatch?.[1]) {
    return { path, line: undefined, column: undefined };
  }

  column = columnMatch[1];
  path = path.slice(0, -columnMatch[0].length);
  const lineMatch = path.match(/:(\d+)$/u);
  if (lineMatch?.[1]) {
    line = lineMatch[1];
    path = path.slice(0, -lineMatch[0].length);
  } else {
    line = column;
    column = undefined;
  }

  return { path, line, column };
}

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function canonicalizeWindowsDrivePath(path: string): string {
  return /^\/[A-Za-z]:\//u.test(path) ? path.slice(1) : path;
}

function trimTrailingPathSeparators(path: string): string {
  return path.replace(/[\\/]+$/u, "");
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function stripRelativePrefixes(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

export interface WorkspaceRelativePathFormatOptions {
  /** Include the workspace directory name before the relative path. Defaults to true. */
  readonly includeWorkspaceLabel?: boolean;
}

/**
 * Shortens a path inside a workspace while preserving optional line and column
 * suffixes. Absolute paths outside the workspace remain absolute.
 */
export function formatWorkspaceRelativePath(
  pathWithPosition: string,
  workspaceRoot: string | undefined,
  options?: WorkspaceRelativePathFormatOptions,
): string {
  const { path, line, column } = splitPathAndPosition(pathWithPosition);
  const normalizedPath = canonicalizeWindowsDrivePath(normalizePathSeparators(path));

  let displayPath = normalizedPath;
  if (workspaceRoot) {
    const normalizedWorkspaceRoot = canonicalizeWindowsDrivePath(
      normalizePathSeparators(trimTrailingPathSeparators(workspaceRoot)),
    );
    const workspaceLabel = basenameOfPath(normalizedWorkspaceRoot);
    const pathForCompare = normalizedPath.toLowerCase();
    const workspaceForCompare = normalizedWorkspaceRoot.toLowerCase();
    const workspaceWithSeparator = `${workspaceForCompare}/`;
    const workspaceLabelWithSeparator = `${workspaceLabel.toLowerCase()}/`;
    const includeWorkspaceLabel = options?.includeWorkspaceLabel ?? true;

    if (pathForCompare === workspaceForCompare) {
      displayPath = includeWorkspaceLabel ? workspaceLabel : ".";
    } else if (pathForCompare.startsWith(workspaceWithSeparator)) {
      const relativeSuffix = normalizedPath.slice(normalizedWorkspaceRoot.length + 1);
      displayPath = includeWorkspaceLabel ? `${workspaceLabel}/${relativeSuffix}` : relativeSuffix;
    } else if (!normalizedPath.startsWith("/") && !/^[A-Za-z]:\//u.test(normalizedPath)) {
      const relativePath = stripRelativePrefixes(normalizedPath);
      if (pathForCompare.startsWith(workspaceLabelWithSeparator)) {
        displayPath = includeWorkspaceLabel
          ? normalizedPath
          : normalizedPath.slice(workspaceLabel.length + 1);
      } else {
        displayPath = includeWorkspaceLabel ? `${workspaceLabel}/${relativePath}` : relativePath;
      }
    }
  }

  if (!line) return displayPath;
  return `${displayPath}:${line}${column ? `:${column}` : ""}`;
}
