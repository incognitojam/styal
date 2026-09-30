const SOURCE_PRS_HEADING = /^(?:#{1,6}\s+)?Source PRs?:?\s*$/iu;
const ESCAPED_SOURCE_LIST_ITEM = /^\s*-\s+`pingdotgg\/t3code#([1-9]\d*)`\s*$/u;
const UPSTREAM_PR_TRAILER = /^Upstream-PR:[\t ]*(.*)$/iu;
const UPSTREAM_COMMIT_TRAILER = /^Upstream-Commit:[\t ]*(.*)$/iu;
const SOURCE_PR_LIST = /^\s*[1-9]\d*(?:\s*,\s*[1-9]\d*)*\s*$/u;
const SOURCE_COMMIT_LIST = /^\s*[0-9a-f]{40}(?:\s*,\s*[0-9a-f]{40})*\s*$/u;
const SOURCE_PR_LIST_FRAGMENT = /^\s*[1-9]\d*(?:\s*,\s*[1-9]\d*)*\s*,?\s*$/u;
const SOURCE_COMMIT_LIST_FRAGMENT = /^\s*[0-9a-f]{40}(?:\s*,\s*[0-9a-f]{40})*\s*,?\s*$/u;

export interface UpstreamProvenance {
  readonly pullRequestNumbers: ReadonlyArray<number>;
  readonly commitShas: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

/** Squash messages retain Markdown examples from PR descriptions, not just import metadata. */
export function withoutFencedExamples(message: string): string {
  let fence: string | undefined;
  return message
    .split(/\r?\n/u)
    .map((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
      if (fence !== undefined) {
        if (
          marker &&
          marker[1]![0] === fence[0] &&
          marker[1]!.length >= fence.length &&
          !marker[2]!.trim()
        )
          fence = undefined;
        return "";
      }
      if (marker) {
        fence = marker[1];
        return "";
      }
      return line;
    })
    .join("\n");
}

function sortedNumbers(numbers: Iterable<number>): ReadonlyArray<number> {
  return [...new Set(numbers)].toSorted((left, right) => left - right);
}

function parseNumberList(value: string): ReadonlyArray<number> | null {
  if (!SOURCE_PR_LIST.test(value)) return null;
  const numbers = value.split(",").map((part) => Number(part.trim()));
  return numbers.every(Number.isSafeInteger) ? sortedNumbers(numbers) : null;
}

function trailerValues(
  message: string,
  trailer: RegExp,
  continuation: RegExp,
): ReadonlyArray<string> {
  const values: Array<string> = [];
  const lines = message.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const match = (lines[index] ?? "").match(trailer);
    if (match === null) continue;

    let value = match[1] ?? "";
    while (value.trimEnd().endsWith(",")) {
      const next = lines[index + 1];
      if (next === undefined || !continuation.test(next)) break;
      value += next;
      index += 1;
    }
    values.push(value);
  }
  return values;
}

function sourceSectionNumbers(message: string): ReadonlyArray<number> {
  const numbers: Array<number> = [];
  const lines = message.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!SOURCE_PRS_HEADING.test(lines[index] ?? "")) continue;
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim().length === 0) index += 1;
    for (; index < lines.length; index += 1) {
      const match = (lines[index] ?? "").match(ESCAPED_SOURCE_LIST_ITEM);
      if (match === null) break;
      numbers.push(Number(match[1]));
    }
  }
  return sortedNumbers(numbers);
}

/**
 * Reads source provenance that survives on `main`: explicit trailers on intake
 * commits and escaped references under a `Source PRs` section in fork squash
 * commit bodies.
 */
export function parseUpstreamProvenance(messages: ReadonlyArray<string>): UpstreamProvenance {
  const pullRequestNumbers = new Set<number>();
  const commitShas = new Set<string>();
  const errors: Array<string> = [];

  for (const rawMessage of messages) {
    const message = withoutFencedExamples(rawMessage);
    for (const number of sourceSectionNumbers(message)) pullRequestNumbers.add(number);
    for (const value of trailerValues(
      message,
      UPSTREAM_COMMIT_TRAILER,
      SOURCE_COMMIT_LIST_FRAGMENT,
    )) {
      const parsed = parseSourceCommitInput(value);
      if (parsed === null || parsed.length === 0) {
        errors.push(
          "Upstream-Commit metadata must contain comma-separated full lowercase commit SHAs.",
        );
        continue;
      }
      for (const sha of parsed) commitShas.add(sha);
    }
    for (const value of trailerValues(message, UPSTREAM_PR_TRAILER, SOURCE_PR_LIST_FRAGMENT)) {
      const parsed = parseNumberList(value);
      if (parsed === null) {
        errors.push("Upstream-PR metadata must contain comma-separated pull request numbers.");
        continue;
      }
      for (const number of parsed) pullRequestNumbers.add(number);
    }
  }

  return {
    pullRequestNumbers: sortedNumbers(pullRequestNumbers),
    commitShas: [...commitShas].toSorted(),
    errors: [...new Set(errors)],
  };
}

export function parseSourcePullRequestInput(value: string): ReadonlyArray<number> | null {
  if (value.trim().length === 0) return [];
  return parseNumberList(value);
}

export function parseSourceCommitInput(value: string): ReadonlyArray<string> | null {
  if (value.trim().length === 0) return [];
  if (!SOURCE_COMMIT_LIST.test(value)) return null;
  return [...new Set(value.split(",").map((part) => part.trim()))].toSorted();
}
