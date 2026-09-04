const ESCAPED_UPSTREAM_REFERENCE = /`pingdotgg\/t3code#([1-9]\d*)`/gu;
const UPSTREAM_PR_TRAILER = /^Upstream-PR:\s*([^\r\n]*)$/gmu;
const SOURCE_PR_LIST = /^\s*[1-9]\d*(?:\s*,\s*[1-9]\d*)*\s*$/u;

export interface UpstreamProvenance {
  readonly pullRequestNumbers: ReadonlyArray<number>;
  readonly errors: ReadonlyArray<string>;
}

function sortedNumbers(numbers: Iterable<number>): ReadonlyArray<number> {
  return [...new Set(numbers)].toSorted((left, right) => left - right);
}

function parseNumberList(value: string): ReadonlyArray<number> | null {
  if (!SOURCE_PR_LIST.test(value)) return null;
  const numbers = value.split(",").map((part) => Number(part.trim()));
  return numbers.every(Number.isSafeInteger) ? sortedNumbers(numbers) : null;
}

/**
 * Reads source provenance that survives on `main`: explicit trailers on intake
 * commits and escaped source references retained in fork squash commit bodies.
 */
export function parseUpstreamProvenance(messages: ReadonlyArray<string>): UpstreamProvenance {
  const pullRequestNumbers = new Set<number>();
  const errors: Array<string> = [];

  for (const message of messages) {
    for (const match of message.matchAll(ESCAPED_UPSTREAM_REFERENCE)) {
      pullRequestNumbers.add(Number(match[1]));
    }
    for (const match of message.matchAll(UPSTREAM_PR_TRAILER)) {
      const parsed = parseNumberList(match[1] ?? "");
      if (parsed === null) {
        errors.push("Upstream-PR metadata must contain comma-separated pull request numbers.");
        continue;
      }
      for (const number of parsed) pullRequestNumbers.add(number);
    }
  }

  return {
    pullRequestNumbers: sortedNumbers(pullRequestNumbers),
    errors: [...new Set(errors)],
  };
}

export function parseSourcePullRequestInput(value: string): ReadonlyArray<number> | null {
  return parseNumberList(value);
}
