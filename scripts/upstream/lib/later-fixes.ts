import { withoutFencedExamples } from "./provenance.ts";

export interface BatchCommit {
  readonly sha: string;
  readonly pr: number | null;
}

export interface LaterCommit {
  readonly sha: string;
  readonly pr: number | null;
  /** The PR title when there is a PR, which a merge commit's subject does not carry. */
  readonly title: string;
  /** The commit message, followed by the PR description when there is one. */
  readonly text: string;
}

export interface LaterFix {
  readonly sha: string;
  readonly pr: number | null;
  readonly title: string;
  /** The sentence that names the batch commit, quoted as the reason it was flagged. */
  readonly evidence: string;
  /** The fork's tracked PR reason, when the fork already tracks the fix. */
  readonly tracked?: string;
}

const FIX_TITLE = /^(fix|revert)\b/iu;
const EVIDENCE_LENGTH = 240;

/**
 * Upstream fix and revert commits after a batch that name one of its commits: by PR number
 * (`#123`, `owner/repo#123`, or an `owner/repo/pull/123` link), or by SHA after "reverts commit".
 * Wording and shared files alone flagged mostly unrelated fixes, so a fix counts only when it
 * names the commit.
 */
export function laterFixesByBatchCommit(
  batch: ReadonlyArray<BatchCommit>,
  later: ReadonlyArray<LaterCommit>,
  repository: string,
): ReadonlyMap<string, ReadonlyArray<LaterFix>> {
  const byPr = new Map(
    batch.flatMap((commit) => (commit.pr === null ? [] : [[commit.pr, commit.sha] as const])),
  );
  const repo = repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const reference = new RegExp(
    `(?<![\\w/.-])(?:${repo})?#(\\d+)\\b|(?<![\\w-])${repo}/pulls?/(\\d+)\\b|\\breverts commit ([0-9a-f]{7,40})\\b`,
    "gu",
  );
  const result = new Map<string, Array<LaterFix>>();
  for (const commit of later) {
    if (!FIX_TITLE.test(commit.title)) continue;
    const named = new Map<string, string>();
    for (const line of withoutFencedExamples(commit.text).split("\n")) {
      const foreignLinks = [...line.matchAll(/\[[^\]]*\]\(([^)]*)\)/gu)]
        .filter((link) => !new RegExp(`(?<![\\w-])${repo}/`, "u").test(link[1]!))
        .map((link) => [link.index, link.index + link[0].length] as const);
      for (const match of line.matchAll(reference)) {
        if (foreignLinks.some(([start, end]) => match.index >= start && match.index < end))
          continue;
        // Only a revert names a commit by SHA; other SHAs are usually the main a PR was tested against.
        const sha = match[3]
          ? batch.find((candidate) => candidate.sha.startsWith(match[3]!))?.sha
          : byPr.get(Number(match[1] ?? match[2]));
        if (sha && sha !== commit.sha && !named.has(sha))
          named.set(sha, sentenceAt(line, match.index));
      }
    }
    for (const [target, evidence] of named) {
      const fixes = result.get(target) ?? [];
      fixes.push({ sha: commit.sha, pr: commit.pr, title: commit.title, evidence });
      result.set(target, fixes);
    }
  }
  return result;
}

/** The sentence of `line` around `index`, with Markdown links reduced to their text. */
function sentenceAt(line: string, index: number): string {
  let start = 0;
  for (const boundary of line.matchAll(/[.!?]\s+/gu)) {
    const next = boundary.index + boundary[0].length;
    if (next > index) break;
    start = next;
  }
  const end = /[.!?](?=\s|$)/u.exec(line.slice(index));
  const raw = line.slice(start, end ? index + end.index + 1 : line.length);
  const offset = index - start;
  const window =
    raw.length <= EVIDENCE_LENGTH
      ? raw
      : raw.slice(Math.max(0, offset - EVIDENCE_LENGTH / 2), offset + EVIDENCE_LENGTH / 2);
  const sentence = window
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/^\s*(?:[-*>]|#+)\s+/u, "")
    .trim();
  return window === raw ? sentence : `…${sentence}…`;
}
