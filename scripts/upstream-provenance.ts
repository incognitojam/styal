const SOURCE_PRS_HEADING = /^(?:#{1,6}\s+)?Source PRs?:?\s*$/iu;
const ESCAPED_SOURCE_LIST_ITEM = /^\s*-\s+`pingdotgg\/t3code#([1-9]\d*)`\s*$/u;
const UPSTREAM_PR_TRAILER = /^Upstream-PR:\s*([^\r\n]*)$/gimu;
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
  const errors: Array<string> = [];

  for (const message of messages) {
    for (const number of sourceSectionNumbers(message)) pullRequestNumbers.add(number);
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
