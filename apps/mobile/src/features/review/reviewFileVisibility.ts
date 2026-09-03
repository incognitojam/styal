import { useCallback, useMemo } from "react";
import { diffFileTier } from "@t3tools/shared/diffFileOrder";

import { updateReviewExpandedFileIds, updateReviewViewedFileIds } from "./reviewState";
import type { ReviewRenderableFile } from "./reviewModel";

export function getDefaultReviewExpandedFileIds(
  files: ReadonlyArray<ReviewRenderableFile>,
  generatedPaths: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  const generatedPathSet = new Set(generatedPaths);
  return files
    .filter((file) => diffFileTier(file.path, generatedPathSet) !== "generated")
    .map((file) => file.id);
}

export function getValidReviewFileIds(
  files: ReadonlyArray<ReviewRenderableFile>,
  fileIds: ReadonlyArray<string> | undefined,
  generatedPaths: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  if (fileIds === undefined) {
    return getDefaultReviewExpandedFileIds(files, generatedPaths);
  }

  const fileIdSet = new Set(files.map((file) => file.id));
  return fileIds.filter((id) => fileIdSet.has(id));
}

export function getValidExplicitReviewFileIds(
  files: ReadonlyArray<ReviewRenderableFile>,
  fileIds: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (fileIds === undefined) {
    return [];
  }

  return getValidReviewFileIds(files, fileIds);
}

export function toggleReviewFileId(
  fileIds: ReadonlyArray<string>,
  fileId: string,
): ReadonlyArray<string> {
  return fileIds.includes(fileId) ? fileIds.filter((id) => id !== fileId) : [...fileIds, fileId];
}

export function removeReviewFileId(
  fileIds: ReadonlyArray<string>,
  fileId: string,
): ReadonlyArray<string> {
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

  const expandedFileIds = useMemo(
    () => getValidReviewFileIds(files, cachedExpandedFileIds, generatedPaths),
    [cachedExpandedFileIds, files, generatedPaths],
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

      updateReviewExpandedFileIds(threadKey, sectionId, (existing) =>
        toggleReviewFileId(getValidReviewFileIds(files, existing, generatedPaths), fileId),
      );
    },
    [files, generatedPaths, sectionId, threadKey],
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

      if (shouldCollapse) {
        updateReviewExpandedFileIds(threadKey, sectionId, (existing) =>
          removeReviewFileId(getValidReviewFileIds(files, existing, generatedPaths), fileId),
        );
      }
    },
    [files, generatedPaths, sectionId, threadKey, viewedFileIds],
  );

  return {
    expandedFileIds,
    viewedFileIds,
    collapsedFileIds,
    toggleExpandedFile,
    toggleViewedFile,
  };
}
