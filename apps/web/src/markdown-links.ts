import { fileBasename, workspaceRelativeFilePath } from "@t3tools/shared/path";
import {
  inlineCodeFilePathCandidate,
  isRelativeFilePath,
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkTarget,
} from "@t3tools/shared/markdownLinks";
import { parseFileUrlHref, splitFilePathPosition } from "@t3tools/shared/fileLinks";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { isTerminalLinkActivation } from "./terminal-links";

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
}

export function shouldOpenMarkdownFileLinkInEditor(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform?: string,
): boolean {
  return isTerminalLinkActivation(event, platform);
}

export function shouldOpenMarkdownFileLinkInBrowserByDefault(path: string): boolean {
  return /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");
}

function pathParentSegments(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.slice(0, -1);
}

/**
 * Builds the shortest useful parent labels for same-named file chips. Paths
 * inside the active workspace are compared relative to it so a generated
 * worktree directory never becomes presentation chrome.
 */
export function buildMarkdownFileLinkParentSuffixes(
  links: ReadonlyArray<Pick<MarkdownFileLinkMeta, "filePath" | "workspaceRelativePath">>,
): Map<string, string> {
  const groups = new Map<
    string,
    Map<string, { readonly displayPath: string; readonly filePaths: Set<string> }>
  >();
  for (const link of links) {
    const basename = fileBasename(link.filePath);
    if (!basename) continue;
    const group =
      groups.get(basename) ??
      new Map<string, { readonly displayPath: string; readonly filePaths: Set<string> }>();
    const normalizedPath = link.filePath.replaceAll("\\", "/");
    const existing = group.get(normalizedPath);
    if (existing) {
      existing.filePaths.add(link.filePath);
    } else {
      group.set(normalizedPath, {
        displayPath: link.workspaceRelativePath ?? link.filePath,
        filePaths: new Set([link.filePath]),
      });
    }
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    const uniquePaths = [...group.entries()];
    if (uniquePaths.length < 2) continue;

    const parentSegmentsByPath = new Map(
      uniquePaths.map(([filePath, entry]) => [filePath, pathParentSegments(entry.displayPath)]),
    );
    const minUniqueDepthByPath = new Map<string, number>();

    for (const [filePath] of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      let resolvedDepth = segments.length;
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");
        const collision = uniquePaths.some(([otherPath]) => {
          if (otherPath === filePath) return false;
          const otherSegments = parentSegmentsByPath.get(otherPath) ?? [];
          return otherSegments.slice(-depth).join("/") === candidate;
        });
        if (!collision) {
          resolvedDepth = depth;
          break;
        }
      }
      minUniqueDepthByPath.set(filePath, resolvedDepth);
    }

    for (const [filePath, entry] of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      if (segments.length === 0) continue;
      const minUniqueDepth = minUniqueDepthByPath.get(filePath) ?? 1;
      const suffixDepth = Math.min(segments.length, Math.max(minUniqueDepth, 2));
      const suffix = segments.slice(-suffixDepth).join("/");
      for (const originalPath of entry.filePaths) {
        suffixByPath.set(originalPath, suffix);
      }
    }
  }

  return suffixByPath;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(normalizeMarkdownLinkDestination(href));
  return target ? `${target.path}${target.hash}` : null;
}

/**
 * Inline code spans mostly hold identifiers, commands, and refs (`node.meta`,
 * `origin/main`) rather than deliberate link destinations, so auto-linking
 * them demands stronger path evidence than an explicit markdown link does:
 * an unambiguous path prefix, a file extension, or a :line suffix.
 */
export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const candidate = inlineCodeFilePathCandidate(codeText);
  if (candidate === null) return null;

  return resolveMarkdownFileLinkMeta(
    candidate,
    cwd,
    inlineCodePathNamesFromWorkspaceRoot(candidate, cwd, baseDir) ? cwd : baseDir,
  );
}

/**
 * Prose in a workspace file names other files from the repo root (`docs/ai/design.md`),
 * unlike an explicit link. Single-segment names (`design.md:12`) and `./`, `../`
 * paths still read as siblings, and files outside the workspace keep their own base.
 */
function inlineCodePathNamesFromWorkspaceRoot(
  candidate: string,
  cwd: string | undefined,
  baseDir: string | undefined,
): boolean {
  if (!cwd || !baseDir || !isRelativeFilePath(candidate)) return false;
  if (/^(?:~|\.{1,2})\//.test(candidate)) return false;
  if (!splitFilePathPosition(candidate).path.includes("/")) return false;
  return workspaceRelativeFilePath(baseDir, cwd) !== null;
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd, baseDir);
  if (!targetPath) return null;
  return buildFileLinkMetaFromTarget(targetPath, cwd);
}

function buildFileLinkMetaFromTarget(targetPath: string, cwd?: string): MarkdownFileLinkMeta {
  const { path, line, column } = splitFilePathPosition(targetPath);
  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd, { includeWorkspaceLabel: false }),
    workspaceRelativePath: workspaceRelativeFilePath(path, cwd),
    basename: fileBasename(path),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}
