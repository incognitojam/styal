import type { PullRequestDetail, PullRequestLabelCandidate } from "@t3tools/contracts";

/** A truncated repository catalogue may omit labels that this PR still needs to remove. */
export function cachedPullRequestLabelCandidates(
  catalogue: ReadonlyArray<Omit<PullRequestLabelCandidate, "isApplied">>,
  labels: PullRequestDetail["labels"],
): ReadonlyArray<PullRequestLabelCandidate> {
  const names = new Set(catalogue.map((label) => label.name));
  const applied = new Set(labels.map((label) => label.name));
  return [
    ...labels
      .filter((label) => !names.has(label.name))
      .map((label) => ({ ...label, description: null, isApplied: true })),
    ...catalogue.map((label) => ({ ...label, isApplied: applied.has(label.name) })),
  ];
}
