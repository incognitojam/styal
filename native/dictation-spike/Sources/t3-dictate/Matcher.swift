import Foundation

// Deterministic identifier recovery.
//
// The task is fuzzy string matching, not reasoning: "work tree path" -> worktreePath.
// Doing it in code cannot hallucinate, cannot corrupt text it does not match, and
// runs in microseconds. A small model given the same job invented identifiers and
// damaged a correct sentence (see finding 7).

/// `worktreePath` -> "worktree path", `ChildProcessSpawner` -> "child process spawner",
/// `HTTPClient` -> "http client", `parseURL` -> "parse url".
///
/// Consecutive capitals are one word. Splitting per capital produced "h t t p
/// client" (5 words), which the window-size filter then rejected against the
/// 2-token "HTTP client" the speech model actually emits.
func spokenWords(of identifier: String) -> [String] {
  let characters = Array(identifier)
  var words: [String] = []
  var current = ""

  for (offset, character) in characters.enumerated() {
    if character == "_" || character == "-" {
      if !current.isEmpty { words.append(current) }
      current = ""
      continue
    }

    let previous = offset > 0 ? characters[offset - 1] : nil
    let next = offset + 1 < characters.count ? characters[offset + 1] : nil

    // Break before a capital that starts a new word: either the previous
    // character was not a capital (fooBar), or this capital ends an acronym run
    // and begins a word (HTTPClient -> HTTP | Client).
    let startsWord = character.isUppercase
      && !current.isEmpty
      && (!(previous?.isUppercase ?? false) || (next?.isLowercase ?? false))

    if startsWord {
      words.append(current)
      current = ""
    }
    current.append(Character(String(character).lowercased()))
  }

  if !current.isEmpty { words.append(current) }
  return words
}

func spokenForm(of identifier: String) -> String {
  spokenWords(of: identifier).joined(separator: " ")
}

func levenshtein(_ a: [Character], _ b: [Character]) -> Int {
  if a.isEmpty { return b.count }
  if b.isEmpty { return a.count }
  var previous = Array(0...b.count)
  var current = [Int](repeating: 0, count: b.count + 1)
  for i in 1...a.count {
    current[0] = i
    for j in 1...b.count {
      let cost = a[i - 1] == b[j - 1] ? 0 : 1
      current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    swap(&previous, &current)
  }
  return previous[b.count]
}

/// Compares with spaces removed, so "work tree" and "worktree" are equivalent —
/// which is exactly the split the speech model keeps introducing.
func similarity(_ lhs: String, _ rhs: String) -> Double {
  let a = Array(lhs.replacingOccurrences(of: " ", with: ""))
  let b = Array(rhs.replacingOccurrences(of: " ", with: ""))
  if a.isEmpty || b.isEmpty { return 0 }
  let distance = levenshtein(a, b)
  return 1.0 - Double(distance) / Double(max(a.count, b.count))
}

struct VocabularyEntry {
  let identifier: String
  let spoken: String
  let words: [String]
  let wordCount: Int
  /// Length with spaces stripped, used to skip entries too short to match safely.
  let squashedLength: Int
}

func buildVocabulary(_ identifiers: [String]) -> [VocabularyEntry] {
  identifiers.map { identifier in
    let words = spokenWords(of: identifier)
    let spoken = words.joined(separator: " ")
    return VocabularyEntry(
      identifier: identifier,
      spoken: spoken,
      words: words,
      wordCount: words.count,
      squashedLength: spoken.replacingOccurrences(of: " ", with: "").count
    )
  }
}

struct MatcherToken {
  /// Original text including any attached punctuation.
  let raw: String
  /// Lowercased letters and digits only, for comparison.
  let normalized: String
  let leadingPunctuation: String
  let trailingPunctuation: String

  /// A window must not extend past a token that ends a sentence.
  var endsSentence: Bool { trailingPunctuation.contains { ".!?".contains($0) } }
  /// Any trailing punctuation makes this a poor interior token for a window.
  var hasTrailingPunctuation: Bool { !trailingPunctuation.isEmpty }
}

func tokenize(_ text: String) -> [MatcherToken] {
  text.split(whereSeparator: { $0 == " " || $0 == "\t" }).map { piece in
    let raw = String(piece)
    var core = raw
    var trailing = ""
    var leading = ""
    while let last = core.last, !last.isLetter, !last.isNumber {
      trailing = String(last) + trailing
      core.removeLast()
    }
    while let first = core.first, !first.isLetter, !first.isNumber {
      leading.append(first)
      core.removeFirst()
    }
    return MatcherToken(
      raw: raw,
      normalized: core.lowercased().filter { $0.isLetter || $0.isNumber },
      leadingPunctuation: leading,
      trailingPunctuation: trailing
    )
  }
}

/// A ratio threshold lets absolute edit tolerance grow with candidate length:
/// at 0.75 a 17-char identifier accepts 4 edits while a 7-char one accepts 1.
/// That is why "change" -> onChange and "exchange" -> onChange both score exactly
/// 0.75 — two edits on an 8-character candidate. A length-banded budget, as used
/// by spelling correctors, caps absolute distance instead.
func editBudget(forCandidateLength length: Int, shrinking: Bool) -> Int {
  let base: Int
  switch length {
  case ..<9: base = 1
  case ..<15: base = 2
  default: base = 3
  }
  // A window with fewer words than the identifier is inherently speculative:
  // the speaker may simply have said a shorter, unrelated word.
  return shrinking ? max(0, base - 1) : base
}

struct Substitution {
  let before: String
  let after: String
  let score: Double
}

struct MatchResult {
  let text: String
  let substitutions: [Substitution]
}

/// Function words never begin or end an identifier. Without this guard, a window
/// can absorb a neighbouring short word almost for free — "map error on" scores
/// 0.80 against `mapError`, and "Update the" scores 0.78 against `updatedAt`.
let boundaryStopwords: Set<String> = [
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "by", "for",
  "from", "with", "then", "so", "is", "was", "be", "it", "this", "you",
  "i", "we", "he", "she", "they", "as", "if", "not", "do", "does", "did",
]
// Deliberately absent: "at" and "that". Speech renders `createdAt` as "created
// at" or "created that", so both are load-bearing parts of an identifier here.

/// Evaluates every window size at each position and takes the globally best score
/// rather than the longest match, so a longer window has to genuinely fit better.
func applyVocabulary(
  to text: String,
  vocabulary: [VocabularyEntry],
  threshold: Double,
  useEditBudget: Bool = false,
  minimumLength: Int = 6
) -> MatchResult {
  // Line by line, so a window can never span a newline and the original line
  // structure survives.
  var allSubstitutions: [Substitution] = []
  let lines = text.components(separatedBy: "\n").map { line -> String in
    let result = matchLine(
      line,
      vocabulary: vocabulary,
      threshold: threshold,
      useEditBudget: useEditBudget,
      minimumLength: minimumLength
    )
    allSubstitutions.append(contentsOf: result.substitutions)
    return result.text
  }
  return MatchResult(text: lines.joined(separator: "\n"), substitutions: allSubstitutions)
}

/// Minimum score a match must beat its runner-up by. Without this, two similar
/// identifiers (`getUser` / `getUsers`) resolve by vocabulary order.
let ambiguityMargin = 0.05

private func matchLine(
  _ text: String,
  vocabulary: [VocabularyEntry],
  threshold: Double,
  useEditBudget: Bool,
  minimumLength: Int
) -> MatchResult {
  let tokens = tokenize(text)
  let candidates = vocabulary.filter { $0.squashedLength >= minimumLength }
  let maximumWindow = candidates.map(\.wordCount).max() ?? 1

  var output: [String] = []
  var substitutions: [Substitution] = []
  var index = 0

  while index < tokens.count {
    var best: (entry: VocabularyEntry, score: Double, size: Int)?
    var runnerUp: Double = 0

    for windowSize in 1...max(1, min(maximumWindow, tokens.count - index)) {
      let window = tokens[index..<(index + windowSize)]

      // Never span a sentence boundary, and never swallow an interior token that
      // carried punctuation — "exit. The code" must not become exitCode.
      if window.dropLast().contains(where: { $0.hasTrailingPunctuation }) { break }

      guard let first = window.first?.normalized, let last = window.last?.normalized,
            !first.isEmpty, !last.isEmpty
      else {
        if window.last?.endsSentence == true { break }
        continue
      }

      let phrase = window.map(\.normalized).joined(separator: " ")
      if phrase.replacingOccurrences(of: " ", with: "").count < minimumLength { continue }

      for entry in candidates where abs(entry.wordCount - windowSize) <= 1 {
        // The boundary guard exists to stop a window absorbing a neighbouring
        // function word. It must be waived when the candidate's own spoken form
        // begins or ends with that word — otherwise `isEmpty`, `onClick`,
        // `forEach` and `toString` are structurally unmatchable.
        if boundaryStopwords.contains(first), entry.words.first != first { continue }
        if boundaryStopwords.contains(last), entry.words.last != last { continue }

        let score = similarity(phrase, entry.spoken)
        guard score >= threshold else { continue }

        if useEditBudget {
          let squashedWindow = phrase.replacingOccurrences(of: " ", with: "")
          let squashedEntry = entry.spoken.replacingOccurrences(of: " ", with: "")
          let distance = levenshtein(Array(squashedWindow), Array(squashedEntry))
          let budget = editBudget(
            forCandidateLength: squashedEntry.count,
            shrinking: windowSize < entry.wordCount
          )
          guard distance <= budget else { continue }
        }
        // Strictly greater, so the shortest window wins ties — the extra token in
        // a longer window has to earn its place.
        if score > (best?.score ?? 0) {
          if let previous = best, previous.entry.identifier != entry.identifier {
            runnerUp = max(runnerUp, previous.score)
          }
          best = (entry, score, windowSize)
        } else if entry.identifier != best?.entry.identifier {
          runnerUp = max(runnerUp, score)
        }
      }
    }

    // Too close to call: leave the text alone rather than guess between two
    // plausible identifiers.
    if let candidate = best, candidate.score - runnerUp < ambiguityMargin, runnerUp > 0 {
      best = nil
    }

    if let best {
      let window = tokens[index..<(index + best.size)]
      let leading = window.first?.leadingPunctuation ?? ""
      let trailing = window.last?.trailingPunctuation ?? ""
      output.append(leading + best.entry.identifier + trailing)
      substitutions.append(
        Substitution(
          before: window.map(\.raw).joined(separator: " "),
          after: best.entry.identifier,
          score: best.score
        )
      )
      index += best.size
    } else {
      output.append(tokens[index].raw)
      index += 1
    }
  }

  return MatchResult(text: output.joined(separator: " "), substitutions: substitutions)
}
