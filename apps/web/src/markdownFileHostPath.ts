import { formatFilePathPosition, resolvePathLinkTarget } from "@t3tools/shared/fileLinks";

import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import type { MarkdownFileLinkMeta } from "./markdown-links";

interface MarkdownFileHostPath {
  absolutePath: string;
  matched: boolean;
}

export async function resolveMarkdownFileHostPath(input: {
  meta: MarkdownFileLinkMeta;
  cwd: string | undefined;
  findWorkspaceMatch: (workspaceRelativePath: string) => Promise<string | null>;
}) {
  const { meta, cwd } = input;
  const match =
    meta.workspaceLookupPath && cwd
      ? await input.findWorkspaceMatch(meta.workspaceLookupPath)
      : null;
  return match && cwd
    ? { absolutePath: resolvePathLinkTarget(match, cwd), matched: true }
    : { absolutePath: meta.filePath, matched: false };
}

/** The project an editor opens a link in: the deepest root holding the file, else the thread's. */
export function markdownFileEditorProjectRoot(
  absolutePath: string,
  cwd: string | undefined,
  projectRoots: ReadonlyArray<string>,
) {
  return (
    [cwd, ...projectRoots]
      .filter(
        (root): root is string =>
          root !== undefined && workspaceRelativeFilePath(absolutePath, root) !== null,
      )
      .toSorted((left, right) => right.length - left.length)[0] ?? cwd
  );
}

export function markdownFileEditorTarget(
  meta: MarkdownFileLinkMeta,
  hostPath: MarkdownFileHostPath,
) {
  return hostPath.matched
    ? formatFilePathPosition({ ...meta, path: hostPath.absolutePath })
    : meta.targetPath;
}

export function markdownFileCopyPaths(
  meta: MarkdownFileLinkMeta,
  hostPath: MarkdownFileHostPath,
  cwd: string | undefined,
) {
  const fullPath = markdownFileEditorTarget(meta, hostPath);
  return {
    fullPath,
    relativePath: formatFilePathPosition({
      ...meta,
      path: workspaceRelativeFilePath(hostPath.absolutePath, cwd) ?? meta.filePath,
    }),
  };
}
