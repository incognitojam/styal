import { useCallback, useMemo } from "react";
import { diffFileTier } from "@t3tools/shared/diffFileOrder";

import { updateReviewExpandedFileIds, updateReviewViewedFileIds } from "./reviewState";
import type { ReviewRenderableFile } from "./reviewModel";

// File ids are scoped to one diff text, so a refresh renames every file. Expansion is
// stored by path, which survives a refresh; the occurrence index keeps apart entries
// that share a path, such as the deletion and addition when a file becomes a symlink.
function getReviewFileExpansionKeys(
  files: ReadonlyArray<ReviewRenderableFile>,
): ReadonlyArray<string> {
  const seen = new Map<string, number>();
  return files.map((file) => {
    const occurrence = seen.get(file.path) ?? 0;
    seen.set(file.path, occurrence + 1);
    return `${occurrence}:${file.path}`;
  });
}

// Until the reader folds or unfolds a file, generated files start collapsed.
function getExpandedReviewFileKeys(
  files: ReadonlyArray<ReviewRenderableFile>,
  keys: ReadonlyArray<string>,
  storedKeys: ReadonlyArray<string> | undefined,
  generatedPaths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (storedKeys !== undefined) {
    const storedKeySet = new Set(storedKeys);
    return keys.filter((key) => storedKeySet.has(key));
  }
  const generatedPathSet = new Set(generatedPaths);
  return keys.filter(
    (_, index) => diffFileTier(files[index]!.path, generatedPathSet) !== "generated",
  );
}

export function getExpandedReviewFileIds(
  files: ReadonlyArray<ReviewRenderableFile>,
  storedKeys: ReadonlyArray<string> | undefined,
  generatedPaths: ReadonlyArray<string> = [],
  keys: ReadonlyArray<string> = getReviewFileExpansionKeys(files),
): ReadonlyArray<string> {
  const expandedKeys = new Set(getExpandedReviewFileKeys(files, keys, storedKeys, generatedPaths));
  return files.filter((_, index) => expandedKeys.has(keys[index]!)).map((file) => file.id);
}

function getValidReviewFileIds(
  files: ReadonlyArray<ReviewRenderableFile>,
  fileIds: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (fileIds === undefined) {
    return files.map((file) => file.id);
  }

  const fileIdSet = new Set(files.map((file) => file.id));
  return fileIds.filter((id) => fileIdSet.has(id));
}

function getValidExplicitReviewFileIds(
  files: ReadonlyArray<ReviewRenderableFile>,
  fileIds: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (fileIds === undefined) {
    return [];
  }

  return getValidReviewFileIds(files, fileIds);
}

function toggleReviewFileId(fileIds: ReadonlyArray<string>, fileId: string): ReadonlyArray<string> {
  return fileIds.includes(fileId) ? fileIds.filter((id) => id !== fileId) : [...fileIds, fileId];
}

function removeReviewFileId(fileIds: ReadonlyArray<string>, fileId: string): ReadonlyArray<string> {
  return fileIds.includes(fileId) ? fileIds.filter((id) => id !== fileId) : fileIds;
}

export function useReviewFileVisibility(input: {
  readonly threadKey: string | null;
  readonly sectionId: string | null;
  readonly files: ReadonlyArray<ReviewRenderableFile>;
  readonly cachedExpandedFileIds: ReadonlyArray<string> | undefined;
  readonly cachedViewedFileIds: ReadonlyArray<string> | undefined;
  readonly generatedPaths: ReadonlyArray<string>;
}) {
  const {
    cachedExpandedFileIds,
    cachedViewedFileIds,
    files,
    generatedPaths,
    sectionId,
    threadKey,
  } = input;

  const expansionKeys = useMemo(() => getReviewFileExpansionKeys(files), [files]);
  const expandedFileIds = useMemo(
    () => getExpandedReviewFileIds(files, cachedExpandedFileIds, generatedPaths, expansionKeys),
    [cachedExpandedFileIds, expansionKeys, files, generatedPaths],
  );
  const viewedFileIds = useMemo(
    () => getValidExplicitReviewFileIds(files, cachedViewedFileIds),
    [cachedViewedFileIds, files],
  );
  const collapsedFileIds = useMemo(() => {
    const expandedFileIdSet = new Set(expandedFileIds);
    return files.reduce<string[]>((fileIds, file) => {
      if (!expandedFileIdSet.has(file.id)) {
        fileIds.push(file.id);
      }
      return fileIds;
    }, []);
  }, [expandedFileIds, files]);

  const toggleExpandedFile = useCallback(
    (fileId: string) => {
      if (!threadKey || !sectionId) {
        return;
      }

      const key = expansionKeys[files.findIndex((file) => file.id === fileId)];
      if (key === undefined) {
        return;
      }
      updateReviewExpandedFileIds(threadKey, sectionId, (existing) =>
        toggleReviewFileId(
          getExpandedReviewFileKeys(files, expansionKeys, existing, generatedPaths),
          key,
        ),
      );
    },
    [expansionKeys, files, generatedPaths, sectionId, threadKey],
  );

  const toggleViewedFile = useCallback(
    (fileId: string) => {
      if (!threadKey || !sectionId) {
        return;
      }

      const shouldCollapse = !viewedFileIds.includes(fileId);
      updateReviewViewedFileIds(threadKey, sectionId, (existing) =>
        toggleReviewFileId(getValidExplicitReviewFileIds(files, existing), fileId),
      );

      const key = expansionKeys[files.findIndex((file) => file.id === fileId)];
      if (shouldCollapse && key !== undefined) {
        updateReviewExpandedFileIds(threadKey, sectionId, (existing) =>
          removeReviewFileId(
            getExpandedReviewFileKeys(files, expansionKeys, existing, generatedPaths),
            key,
          ),
        );
      }
    },
    [expansionKeys, files, generatedPaths, sectionId, threadKey, viewedFileIds],
  );

  return {
    expandedFileIds,
    viewedFileIds,
    collapsedFileIds,
    toggleExpandedFile,
    toggleViewedFile,
  };
}
