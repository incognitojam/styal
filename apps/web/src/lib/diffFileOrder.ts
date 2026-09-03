import type { FileDiffMetadata } from "@pierre/diffs";
import {
  diffFileTier,
  orderDiffFiles as orderDiffFilesByRelevance,
  type DiffFileTier,
} from "@t3tools/shared/diffFileOrder";

import { resolveFileDiffPath } from "~/lib/diffRendering";

export { diffFileTier, type DiffFileTier };

const FILE_DIFF_ORDER_ACCESSORS = {
  path: resolveFileDiffPath,
  changedLines: (file: FileDiffMetadata) => [...file.additionLines, ...file.deletionLines],
};

/**
 * Diff files in reading order: source in dependency order, then the tests that cover it, then
 * whatever a tool wrote. `generatedPaths` carries the repository's `linguist-generated`
 * attributions when the diff source provides them.
 */
export function orderDiffFiles(
  files: ReadonlyArray<FileDiffMetadata>,
  generatedPaths?: ReadonlyArray<string>,
): ReadonlyArray<FileDiffMetadata> {
  return orderDiffFilesByRelevance(files, FILE_DIFF_ORDER_ACCESSORS, generatedPaths);
}
