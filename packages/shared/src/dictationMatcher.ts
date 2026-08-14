// Deterministic identifier recovery for dictation.
//
// Speech-to-text transcribes code identifiers as ordinary words — "work tree
// path" for worktreePath, "map error" for mapError. Recovering them is fuzzy
// string matching, not reasoning: doing it in code cannot hallucinate, cannot
// corrupt text it does not match, and runs in microseconds. (A small on-device
// LLM given the same job invented identifiers and damaged a correct sentence.)
//
// Ported from the measured spike in native/dictation-spike (README findings
// 8-17). Every rule below cost a measurement; see the finding cited beside it.

export interface DictationVocabularyEntry {
  readonly identifier: string;
  readonly spoken: string;
  readonly words: readonly string[];
  readonly wordCount: number;
  /** Length with spaces stripped, used to skip entries too short to match safely. */
  readonly squashedLength: number;
}

export interface DictationSubstitution {
  readonly before: string;
  readonly after: string;
  readonly score: number;
  /** Character offset of the substitution in the output text. */
  readonly outputStart: number;
  readonly outputEnd: number;
}

export interface DictationMatchResult {
  readonly text: string;
  readonly substitutions: readonly DictationSubstitution[];
}

const isLetterOrDigit = (char: string): boolean => /[\p{L}\p{N}]/u.test(char);
const isUpper = (char: string): boolean =>
  char !== char.toLowerCase() && char === char.toUpperCase();
const isLower = (char: string): boolean =>
  char !== char.toUpperCase() && char === char.toLowerCase();

/**
 * `worktreePath` -> ["worktree", "path"], `HTTPClient` -> ["http", "client"],
 * `parseURL` -> ["parse", "url"], `thread_id` -> ["thread", "id"].
 *
 * Consecutive capitals stay one word. Splitting per capital produced "h t t p
 * client" (5 words), which the window-size filter then rejected against the
 * 2-token "HTTP client" the speech model actually emits (finding 9 -> 10).
 */
export function spokenWords(identifier: string): string[] {
  const characters = [...identifier];
  const words: string[] = [];
  let current = "";

  for (let offset = 0; offset < characters.length; offset += 1) {
    const character = characters[offset]!;
    if (character === "_" || character === "-") {
      if (current.length > 0) {
        words.push(current);
      }
      current = "";
      continue;
    }

    const previous = offset > 0 ? characters[offset - 1] : undefined;
    const next = offset + 1 < characters.length ? characters[offset + 1] : undefined;

    // Break before a capital that starts a new word: either the previous
    // character was not a capital (fooBar), or this capital ends an acronym run
    // and begins a word (HTTPClient -> HTTP | Client).
    const startsWord =
      isUpper(character) &&
      current.length > 0 &&
      (!(previous !== undefined && isUpper(previous)) ||
        (next !== undefined && isLower(next)));

    if (startsWord) {
      words.push(current);
      current = "";
    }
    current += character.toLowerCase();
  }

  if (current.length > 0) {
    words.push(current);
  }
  return words;
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/**
 * Compares with spaces removed, so "work tree" and "worktree" are equivalent —
 * exactly the split the speech model keeps introducing.
 */
function similarity(lhs: string, rhs: string): number {
  const a = lhs.replaceAll(" ", "");
  const b = rhs.replaceAll(" ", "");
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/**
 * Builds matcher vocabulary from identifiers, collapsing entries whose spoken
 * forms collide (`threadId` and `thread_id` are both "thread id"). Without the
 * collapse the ambiguity margin correctly refuses to guess between them and the
 * identifier is lost entirely (finding 16). First occurrence wins, so callers
 * should order by preference — frequency or recency.
 */
export function buildDictationVocabulary(
  identifiers: readonly string[],
): DictationVocabularyEntry[] {
  const seen = new Set<string>();
  const entries: DictationVocabularyEntry[] = [];
  for (const identifier of identifiers) {
    const words = spokenWords(identifier);
    const spoken = words.join(" ");
    if (seen.has(spoken)) {
      continue;
    }
    seen.add(spoken);
    entries.push({
      identifier,
      spoken,
      words,
      wordCount: words.length,
      squashedLength: spoken.replaceAll(" ", "").length,
    });
  }
  return entries;
}

interface MatcherToken {
  /** Original text including any attached punctuation. */
  readonly raw: string;
  /** Lowercased letters and digits only, for comparison. */
  readonly normalized: string;
  readonly leadingPunctuation: string;
  readonly trailingPunctuation: string;
  /** Any trailing punctuation makes this a poor interior token for a window. */
  readonly hasTrailingPunctuation: boolean;
}

function tokenize(text: string): MatcherToken[] {
  return text
    .split(/[ \t]+/)
    .filter((piece) => piece.length > 0)
    .map((raw) => {
      let core = raw;
      let trailing = "";
      let leading = "";
      while (core.length > 0 && !isLetterOrDigit(core[core.length - 1]!)) {
        trailing = core[core.length - 1]! + trailing;
        core = core.slice(0, -1);
      }
      while (core.length > 0 && !isLetterOrDigit(core[0]!)) {
        leading += core[0]!;
        core = core.slice(1);
      }
      const normalized = [...core.toLowerCase()].filter(isLetterOrDigit).join("");
      return {
        raw,
        normalized,
        leadingPunctuation: leading,
        trailingPunctuation: trailing,
        hasTrailingPunctuation: trailing.length > 0,
      };
    });
}

/**
 * A ratio threshold lets absolute edit tolerance grow with candidate length: at
 * 0.75 a 17-char identifier accepts 4 edits while a 7-char one accepts 1. That
 * is why "change" -> onChange and "exchange" -> onChange both scored exactly
 * 0.75 — two edits on an 8-character candidate — and no ratio threshold could
 * separate them from real matches (finding 9). A length-banded budget, as used
 * by spelling correctors, caps absolute distance instead, and measured
 * threshold-insensitive from 0.50-0.70.
 */
function editBudget(candidateLength: number, shrinking: boolean): number {
  const base = candidateLength < 9 ? 1 : candidateLength < 15 ? 2 : 3;
  // A window with fewer words than the identifier is inherently speculative:
  // the speaker may simply have said a shorter, unrelated word.
  return shrinking ? Math.max(0, base - 1) : base;
}

/**
 * Function words never begin or end an identifier match. Without this guard a
 * window absorbs a neighbouring short word almost for free — "map error on"
 * scores 0.80 against `mapError`, "Update the" scores 0.78 against `updatedAt`.
 *
 * Deliberately absent: "at" and "that". Speech renders `createdAt` as
 * "created at" or "created that", so both are load-bearing identifier parts.
 */
const BOUNDARY_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "by", "for",
  "from", "with", "then", "so", "is", "was", "be", "it", "this", "you",
  "i", "we", "he", "she", "they", "as", "if", "not", "do", "does", "did",
]);

/**
 * Minimum score a match must beat its runner-up by. Without it, two similar
 * identifiers (`getUser` / `getUsers`) resolve by vocabulary order.
 */
const AMBIGUITY_MARGIN = 0.05;

/** Below the ratio floor nothing is considered, whatever the edit budget says. */
const SCORE_FLOOR = 0.6;

/** Spoken forms shorter than this squashed length are too risky to match. */
const MINIMUM_SQUASHED_LENGTH = 6;

/**
 * Applies vocabulary substitutions to transcribed text. Runs per line so a
 * window can never span a newline; within a line, windows never span a token
 * carrying trailing punctuation ("exit. The code" must not become `exitCode` —
 * and ASR sometimes renders that boundary as a comma, so the rule covers all
 * trailing punctuation, not just sentence-final; findings 10, 11).
 */
export function applyDictationVocabulary(
  text: string,
  vocabulary: readonly DictationVocabularyEntry[],
): DictationMatchResult {
  const substitutions: DictationSubstitution[] = [];
  let outputLength = 0;
  const lines = text.split("\n").map((line) => {
    const result = matchLine(line, vocabulary, outputLength);
    substitutions.push(...result.substitutions);
    outputLength += result.text.length + 1;
    return result.text;
  });
  return { text: lines.join("\n"), substitutions };
}

function matchLine(
  text: string,
  vocabulary: readonly DictationVocabularyEntry[],
  outputOffset: number,
): DictationMatchResult {
  const tokens = tokenize(text);
  const candidates = vocabulary.filter(
    (entry) => entry.squashedLength >= MINIMUM_SQUASHED_LENGTH,
  );
  const maximumWindow = Math.max(1, ...candidates.map((entry) => entry.wordCount));

  const output: string[] = [];
  const substitutions: DictationSubstitution[] = [];
  let outputLength = 0;
  let index = 0;

  const append = (piece: string): void => {
    output.push(piece);
    outputLength += piece.length + (output.length > 1 ? 1 : 0);
  };

  while (index < tokens.length) {
    let best:
      | { entry: DictationVocabularyEntry; score: number; size: number }
      | undefined;
    let runnerUp = 0;

    const largest = Math.min(maximumWindow, tokens.length - index);
    for (let windowSize = 1; windowSize <= largest; windowSize += 1) {
      const window = tokens.slice(index, index + windowSize);

      // Never swallow an interior token that carried punctuation.
      if (window.slice(0, -1).some((token) => token.hasTrailingPunctuation)) {
        break;
      }

      const first = window[0]!.normalized;
      const last = window[window.length - 1]!.normalized;
      if (first.length === 0 || last.length === 0) {
        continue;
      }

      const phrase = window.map((token) => token.normalized).join(" ");
      if (phrase.replaceAll(" ", "").length < MINIMUM_SQUASHED_LENGTH) {
        continue;
      }

      for (const entry of candidates) {
        if (Math.abs(entry.wordCount - windowSize) > 1) {
          continue;
        }
        // The boundary guard stops a window absorbing a neighbouring function
        // word. It is waived when the candidate's own spoken form begins or
        // ends with that word — otherwise `isEmpty`, `onClick`, `forEach` and
        // `toString` are structurally unmatchable (finding 9).
        if (BOUNDARY_STOPWORDS.has(first) && entry.words[0] !== first) {
          continue;
        }
        if (BOUNDARY_STOPWORDS.has(last) && entry.words[entry.words.length - 1] !== last) {
          continue;
        }

        const score = similarity(phrase, entry.spoken);
        if (score < SCORE_FLOOR) {
          continue;
        }

        const distance = levenshtein(
          phrase.replaceAll(" ", ""),
          entry.spoken.replaceAll(" ", ""),
        );
        if (distance > editBudget(entry.squashedLength, windowSize < entry.wordCount)) {
          continue;
        }

        // Strictly greater, so the shortest window wins ties — the extra token
        // in a longer window has to earn its place.
        if (score > (best?.score ?? 0)) {
          if (best !== undefined && best.entry.identifier !== entry.identifier) {
            runnerUp = Math.max(runnerUp, best.score);
          }
          best = { entry, score, size: windowSize };
        } else if (entry.identifier !== best?.entry.identifier) {
          runnerUp = Math.max(runnerUp, score);
        }
      }
    }

    // Too close to call: leave the text alone rather than guess between two
    // plausible identifiers.
    if (best !== undefined && runnerUp > 0 && best.score - runnerUp < AMBIGUITY_MARGIN) {
      best = undefined;
    }

    if (best !== undefined) {
      const window = tokens.slice(index, index + best.size);
      const leading = window[0]!.leadingPunctuation;
      const trailing = window[window.length - 1]!.trailingPunctuation;
      const separator = output.length > 0 ? 1 : 0;
      const start = outputOffset + outputLength + separator + leading.length;
      append(leading + best.entry.identifier + trailing);
      substitutions.push({
        before: window.map((token) => token.raw).join(" "),
        after: best.entry.identifier,
        score: best.score,
        outputStart: start,
        outputEnd: start + best.entry.identifier.length,
      });
      index += best.size;
    } else {
      append(tokens[index]!.raw);
      index += 1;
    }
  }

  return { text: output.join(" "), substitutions };
}
