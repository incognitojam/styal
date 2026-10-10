const CHERRY_PICK_LINE = /^\(cherry picked from commit ([0-9a-f]{40})\)$/gmu;
const ADAPTATION_NOTE = /^Fork adaptation:[\t ]*(.*)$/mu;
const FORK_FEATURE_TRAILER = /^Fork-Feature:[\t ]*(.*)$/gimu;

/** Upstream commits a candidate commit was cherry-picked from, in message order. */
export function cherryPickSources(message: string): ReadonlyArray<string> {
  return [...new Set(Array.from(message.matchAll(CHERRY_PICK_LINE), (match) => match[1]!))];
}

/** The paragraph that starts with `Fork adaptation:`, joined onto one line. */
export function forkAdaptationNote(message: string): string | null {
  const match = ADAPTATION_NOTE.exec(message);
  if (match === null) return null;
  const rest = message.slice(match.index + match[0].length).split(/\r?\n\s*\r?\n/u)[0] ?? "";
  const note = [match[1] ?? "", ...rest.split(/\r?\n/u)]
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");
  return note.length > 0 ? note : null;
}

/** Ledger feature IDs named in `Fork-Feature: id, id` trailers, in message order. */
export function preservedFeatureIds(message: string): ReadonlyArray<string> {
  return [
    ...new Set(
      Array.from(message.matchAll(FORK_FEATURE_TRAILER), (match) => match[1] ?? "")
        .flatMap((value) => value.split(","))
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ];
}

/** Added and removed lines per file, each starting with "+" or "-", in patch order. */
type ChangedLines = Map<string, Array<string>>;

/** Reads `git diff -U0` patches into the lines each file adds and removes. */
export function changedLinesByFile(patches: ReadonlyArray<string>): ChangedLines {
  const files: ChangedLines = new Map();
  for (const patch of patches) {
    let current: Array<string> | null = null;
    for (const line of patch.split("\n")) {
      const header = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
      if (header) {
        const path = header[2]!;
        current = files.get(path) ?? [];
        files.set(path, current);
        continue;
      }
      if (current === null || line.startsWith("+++ ") || line.startsWith("--- ")) continue;
      if (line.startsWith("+") || line.startsWith("-")) current.push(line);
    }
  }
  return files;
}

export interface FileDifference {
  readonly path: string;
  /** Lines upstream's change adds ("+") or removes ("-") in this file, in patch order. */
  readonly upstreamLines: ReadonlyArray<string>;
  /** Lines the picked commit adds or removes in this file, in patch order. */
  readonly forkLines: ReadonlyArray<string>;
  /**
   * A diff from `upstreamLines` to `forkLines`: "-" marks a line only upstream's change has, "+" a
   * line only the picked commit has, and " " shared context. Filled in by the caller.
   */
  readonly interdiff?: ReadonlyArray<string>;
}

/** Lines of `source`, in order, left over after matching each against an equal line of `other`. */
function linesMissingFrom(
  source: ReadonlyArray<string>,
  other: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const available = new Map<string, number>();
  for (const line of other) available.set(line, (available.get(line) ?? 0) + 1);
  return source.filter((line) => {
    const count = available.get(line) ?? 0;
    if (count === 0) return true;
    available.set(line, count - 1);
    return false;
  });
}

/**
 * Compares what the upstream sources change with what the picked commit changes, file by file.
 * Line numbers and context are ignored, so a clean cherry-pick onto moved code still matches.
 */
export function compareWithUpstream(input: {
  readonly upstreamPatches: ReadonlyArray<string>;
  readonly forkPatch: string;
}): ReadonlyArray<FileDifference> {
  const upstream = changedLinesByFile(input.upstreamPatches);
  const fork = changedLinesByFile([input.forkPatch]);
  const paths = [...new Set([...upstream.keys(), ...fork.keys()])].toSorted((left, right) =>
    left.localeCompare(right),
  );
  return paths.flatMap((path) => {
    const upstreamLines = upstream.get(path) ?? [];
    const forkLines = fork.get(path) ?? [];
    return linesMissingFrom(upstreamLines, forkLines).length === 0 &&
      linesMissingFrom(forkLines, upstreamLines).length === 0
      ? []
      : [{ path, upstreamLines, forkLines }];
  });
}

export type CommitComparison =
  | { readonly status: "matches" }
  | { readonly status: "adapted"; readonly files: ReadonlyArray<FileDifference> }
  | { readonly status: "provenance-only" }
  | { readonly status: "unavailable"; readonly reason: string };

export interface CommitReview {
  readonly sha: string;
  readonly subject: string;
  readonly pullRequestNumbers: ReadonlyArray<number>;
  /** Upstream commits the picked commit reproduces: cherry-picked and Upstream-Commit sources. */
  readonly sourceCommits: ReadonlyArray<string>;
  /** Upstream commits named in Upstream-Commit trailers, beside any Upstream-PR. */
  readonly listedCommits: ReadonlyArray<string>;
  readonly adaptationNote: string | null;
  /** Ledger features the commit's adaptation preserves, from its `Fork-Feature` trailers. */
  readonly preservedFeatureIds: ReadonlyArray<string>;
  readonly comparison: CommitComparison;
  /** Fork features whose upstream paths this commit changes. */
  readonly featureIds: ReadonlyArray<string>;
}

/**
 * Problems with how a commit accounts for its differences from upstream. A difference needs a
 * `Fork adaptation:` note, and a cited feature must exist in the ledger. A commit that matches
 * upstream preserves nothing, so it must not cite one.
 */
export function adaptationErrors(
  review: CommitReview,
  knownFeatureIds: ReadonlySet<string>,
): ReadonlyArray<string> {
  const commit = review.sha.slice(0, 12);
  const errors: Array<string> = [];
  if (review.comparison.status === "adapted" && review.adaptationNote === null) {
    errors.push(
      `Candidate commit ${commit} differs from upstream but has no \`Fork adaptation:\` note explaining why.`,
    );
  }
  if (
    (review.comparison.status === "matches" || review.comparison.status === "provenance-only") &&
    review.preservedFeatureIds.length > 0
  ) {
    errors.push(
      `Candidate commit ${commit} matches upstream but cites Fork-Feature ${review.preservedFeatureIds.join(", ")}; remove the trailer.`,
    );
  }
  for (const id of review.preservedFeatureIds) {
    if (!knownFeatureIds.has(id)) {
      errors.push(
        `Candidate commit ${commit} cites Fork-Feature ${id}, which is not in the fork feature ledger.`,
      );
    }
  }
  return errors;
}

const MAX_DIFFERENCE_LINES = 80;

function renderDifferences(files: ReadonlyArray<FileDifference>): string {
  const lines: Array<string> = [];
  let omitted = 0;
  for (const file of files) {
    const block = [
      `# ${file.path}`,
      ...(file.interdiff ??
        linesMissingFrom(file.upstreamLines, file.forkLines)
          .map((line) => `-${line}`)
          .concat(linesMissingFrom(file.forkLines, file.upstreamLines).map((line) => `+${line}`))),
    ];
    const room = MAX_DIFFERENCE_LINES - lines.length;
    if (room <= 0) {
      omitted += block.length;
      continue;
    }
    lines.push(...block.slice(0, room));
    omitted += Math.max(0, block.length - room);
  }
  if (omitted > 0) lines.push(`… ${omitted} more lines`);
  // Changed lines can contain backticks; a longer fence keeps the block intact.
  const fence = "`".repeat(
    Math.max(
      3,
      ...lines.map((line) => (line.match(/`+/gu) ?? []).map((run) => run.length + 1)).flat(),
    ),
  );
  return `${fence}diff\n${lines.join("\n")}\n${fence}`;
}

function pullRequestLinks(repository: string, numbers: ReadonlyArray<number>): string {
  return numbers
    .map((number) => `[${repository}#${number}](https://github.com/${repository}/pull/${number})`)
    .join(", ");
}

function commitLinks(repository: string, shas: ReadonlyArray<string>): string {
  return shas
    .map((sha) => `[\`${sha.slice(0, 10)}\`](https://github.com/${repository}/commit/${sha})`)
    .join(", ");
}

function statusLine(review: CommitReview): string {
  switch (review.comparison.status) {
    case "matches":
      return "Matches upstream.";
    case "adapted": {
      const count = review.comparison.files.length;
      return `Differs from upstream in ${count} ${count === 1 ? "file" : "files"}.`;
    }
    case "provenance-only":
      return "Changes no files; records provenance only.";
    case "unavailable":
      return `Not compared: ${review.comparison.reason}`;
  }
}

/**
 * One section per candidate commit, numbered in candidate order. Commits that differ from upstream
 * or could not be compared come first; the rest are collapsed, since they need no review.
 */
export function renderCommitReviews(input: {
  readonly upstreamRepository: string;
  readonly reviews: ReadonlyArray<CommitReview>;
}): string {
  if (input.reviews.length === 0) return "";
  const sections = input.reviews.map((review, index) => {
    // A PR link already covers the commit cherry-picked from it.
    const shownCommits =
      review.listedCommits.length > 0 || review.pullRequestNumbers.length > 0
        ? review.listedCommits
        : review.sourceCommits;
    const sources = [
      review.pullRequestNumbers.length > 0
        ? pullRequestLinks(input.upstreamRepository, review.pullRequestNumbers)
        : null,
      shownCommits.length > 0
        ? `${shownCommits.length === 1 ? "commit" : "commits"} ${commitLinks(input.upstreamRepository, shownCommits)}`
        : null,
    ].filter((part): part is string => part !== null);
    const lines = [
      `### ${index + 1}. ${review.subject}`,
      "",
      `\`${review.sha.slice(0, 10)}\`${sources.length > 0 ? ` from ${sources.join(" · ")}` : ""}. ${statusLine(review)}`,
    ];
    if (review.adaptationNote !== null) lines.push("", `> ${review.adaptationNote}`);
    if (review.preservedFeatureIds.length > 0) {
      lines.push(
        "",
        `Preserves: ${review.preservedFeatureIds.map((id) => `\`${id}\``).join(", ")}`,
      );
    }
    if (review.comparison.status === "adapted") {
      const firstSource = review.sourceCommits[0];
      lines.push(
        "",
        "<details><summary>How the change differs from upstream's</summary>",
        "",
        "The first column marks a line of the change that only upstream has (`-`) or only this commit has (`+`); the second is the change's own `+` or `-`.",
        "",
        renderDifferences(review.comparison.files),
        "",
        ...(firstSource !== undefined
          ? [
              `Full comparison with the first source: \`git range-diff ${firstSource.slice(0, 12)}^! ${review.sha.slice(0, 12)}^!\``,
              "",
            ]
          : []),
        "</details>",
      );
    }
    if (review.featureIds.length > 0) {
      lines.push("", `Fork features: ${review.featureIds.map((id) => `\`${id}\``).join(", ")}`);
    }
    return lines.join("\n");
  });
  const needsReview = (review: CommitReview) =>
    review.comparison.status === "adapted" || review.comparison.status === "unavailable";
  const reviewed = sections.filter((_, index) => needsReview(input.reviews[index]!));
  const unchanged = sections.filter((_, index) => !needsReview(input.reviews[index]!));
  const provenanceOnly = input.reviews.some(
    (review) => review.comparison.status === "provenance-only",
  );
  const unchangedLabel =
    unchanged.length === 1
      ? `1 commit ${provenanceOnly ? "changes no files" : "matches upstream"}`
      : `${unchanged.length} commits match upstream${provenanceOnly ? " or change no files" : ""}`;
  const parts = [
    ...reviewed,
    ...(unchanged.length > 0
      ? [`<details><summary>${unchangedLabel}</summary>\n\n${unchanged.join("\n\n")}\n\n</details>`]
      : []),
  ];
  const adapted = input.reviews.filter((review) => review.comparison.status === "adapted").length;
  return `\n## Commits\n\n${adapted} of ${input.reviews.length} commits differ from their upstream sources.\n\n${parts.join("\n\n")}\n`;
}
