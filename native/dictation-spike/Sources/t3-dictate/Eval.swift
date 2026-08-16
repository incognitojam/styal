import AVFoundation
import Foundation
import Speech

// Scores the matcher against the recorded corpus.
//
// Recall is measured per identifier rather than by exact transcript match, since
// ASR gets plenty of unrelated words wrong and that is not the matcher's fault.
// False positives are any substitution on a PROSE or FREE item — those contain no
// identifiers, so every change is damage.

let audioExtensions: Set<String> = ["aiff", "aif", "aifc", "wav", "caf", "m4a", "mp3", "mp4", "flac"]

/// Copies an externally-recorded file into the corpus layout eval expects, so a
/// voice memo from a phone can be scored without any tooling on their side.
func runImport() async throws {
  guard let audio = arguments.string("audio") else { fail("import requires --audio <file>") }
  guard let index = arguments.int("item") else { fail("import requires --item <n>") }
  let scriptPath = arguments.string("script") ?? "corpus-remote.txt"
  guard let contents = try? String(contentsOfFile: scriptPath, encoding: .utf8) else {
    fail("could not read script at \(scriptPath)")
  }
  let items = parseCorpusScript(contents)
  guard let item = items.first(where: { $0.index == index }) else {
    fail("script has no item \(index) (it has \(items.count))")
  }

  let directory = URL(fileURLWithPath: arguments.string("out") ?? "corpus-imported")
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

  let source = URL(fileURLWithPath: audio)
  let ext = source.pathExtension.lowercased()
  guard audioExtensions.contains(ext) else {
    fail("unsupported audio extension .\(ext); one of \(audioExtensions.sorted().joined(separator: ", "))")
  }

  let destination = directory.appendingPathComponent(String(format: "%03d.%@", index, ext))
  try? FileManager.default.removeItem(at: destination)
  try FileManager.default.copyItem(at: source, to: destination)

  // Fail here rather than at eval time if the file is unreadable or silent.
  let file = try AVAudioFile(forReading: destination)
  let duration = Double(file.length) / file.processingFormat.sampleRate

  var metadata: [String: Any] = [
    "index": item.index, "kind": item.kind.rawValue, "say": item.say,
    "negativeControl": item.isNegativeControl,
  ]
  metadata["want"] = item.want ?? NSNull()
  let data = try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys, .prettyPrinted])
  try data.write(to: directory.appendingPathComponent(String(format: "%03d.json", index)))

  emit([
    "type": "import", "item": index, "kind": item.kind.rawValue,
    "seconds": duration, "path": destination.path,
  ])
}

/// camelCase, PascalCase, snake_case or digit-bearing tokens.
func extractIdentifiers(from text: String) -> [String] {
  text.split(whereSeparator: { $0 == " " || $0 == "\n" }).compactMap { piece in
    var token = String(piece)
    while let last = token.last, !last.isLetter, !last.isNumber { token.removeLast() }
    guard token.count > 2 else { return nil }
    let hasInnerUppercase = token.dropFirst().contains { $0.isUppercase }
    let hasUnderscore = token.contains("_")
    let hasDigit = token.contains { $0.isNumber }
    return (hasInnerUppercase || hasUnderscore || hasDigit) ? token : nil
  }
}

func containsToken(_ haystack: String, _ token: String) -> Bool {
  haystack.split(whereSeparator: { $0 == " " || $0 == "\n" }).contains { piece in
    var candidate = String(piece)
    while let last = candidate.last, !last.isLetter, !last.isNumber { candidate.removeLast() }
    while let first = candidate.first, !first.isLetter, !first.isNumber { candidate.removeFirst() }
    return candidate == token
  }
}

/// Transcribes one file with SpeechTranscriber and no biasing.
func transcribe(url: URL, locale: Locale) async throws -> String {
  let transcriber = makeTranscriber(locale: locale)
  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
    throw AudioError.noCompatibleFormat
  }
  let audioFile = try AVAudioFile(forReading: url)
  let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
  let analyzer = SpeechAnalyzer(inputSequence: stream, modules: [transcriber])
  let collector = collectResults(from: transcriber.results, startedAt: Date())

  let converter = BufferConverter()
  while audioFile.framePosition < audioFile.length {
    guard let buffer = AVAudioPCMBuffer(pcmFormat: audioFile.processingFormat, frameCapacity: 4096) else {
      throw AudioError.allocationFailed
    }
    try audioFile.read(into: buffer, frameCount: 4096)
    if buffer.frameLength == 0 { break }
    continuation.yield(AnalyzerInput(buffer: try converter.convert(buffer, to: format)))
  }
  continuation.finish()
  try await analyzer.finalizeAndFinishThroughEndOfInput()
  return try await collector.value.text.trimmingCharacters(in: .whitespacesAndNewlines)
}

struct EvalRecord {
  let index: Int
  let kind: CorpusItem.Kind
  let want: String?
  let transcript: String
}

/// Transcripts are cached beside the audio so threshold sweeps do not re-run ASR.
func loadEvalRecords(from directory: URL, locale: Locale, refresh: Bool) async throws -> [EvalRecord] {
  let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    .filter { $0.hasSuffix(".json") && !$0.hasSuffix(".transcript.json") }
    .sorted()

  var records: [EvalRecord] = []
  for name in files {
    let metadataURL = directory.appendingPathComponent(name)
    guard let data = try? Data(contentsOf: metadataURL),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let index = object["index"] as? Int,
          let kindRaw = object["kind"] as? String,
          let kind = CorpusItem.Kind(rawValue: kindRaw)
    else { continue }

    // Remote contributors send whatever their phone records, so accept any
    // container CoreAudio can open rather than only our own .aiff.
    let prefix = String(format: "%03d.", index)
    guard let audioName = try? FileManager.default.contentsOfDirectory(atPath: directory.path)
      .first(where: { $0.hasPrefix(prefix) && audioExtensions.contains(($0 as NSString).pathExtension.lowercased()) })
    else { continue }
    let audioURL = directory.appendingPathComponent(audioName)

    let transcriptURL = directory.appendingPathComponent(String(format: "%03d.transcript.txt", index))
    let transcript: String
    if !refresh, let cached = try? String(contentsOf: transcriptURL, encoding: .utf8) {
      transcript = cached.trimmingCharacters(in: .whitespacesAndNewlines)
    } else {
      log("transcribing \(index)…")
      transcript = try await transcribe(url: audioURL, locale: locale)
      try? transcript.write(to: transcriptURL, atomically: true, encoding: .utf8)
    }

    records.append(
      EvalRecord(index: index, kind: kind, want: object["want"] as? String, transcript: transcript)
    )
  }
  return records.sorted { $0.index < $1.index }
}

struct ThresholdScore {
  var expected = 0
  var recovered = 0
  var falsePositives = 0
  var damagedItems = 0
}

func runEval() async throws {
  let directory = URL(fileURLWithPath: arguments.string("corpus") ?? "corpus")
  let vocabulary = buildVocabulary(loadVocabulary())
  guard !vocabulary.isEmpty else { fail("eval requires --vocab <file>") }

  let records = try await loadEvalRecords(
    from: directory,
    locale: await resolveLocale(locale),
    refresh: arguments.has("refresh")
  )
  guard !records.isEmpty else { fail("no corpus items found in \(directory.path)") }

  let thresholds = arguments.string("thresholds")?
    .split(separator: ",")
    .compactMap { Double($0) } ?? [0.60, 0.65, 0.70, 0.75, 0.80]

  for threshold in thresholds {
    var score = ThresholdScore()

    for record in records {
      let result = applyVocabulary(to: record.transcript, vocabulary: vocabulary, threshold: threshold, useEditBudget: arguments.has("budget"))

      switch record.kind {
      case .code:
        let expected = extractIdentifiers(from: record.want ?? "")
        score.expected += expected.count
        score.recovered += expected.filter { containsToken(result.text, $0) }.count
        // A substitution producing an identifier this sentence never contained.
        let wrong = result.substitutions.filter { !expected.contains($0.after) }
        score.falsePositives += wrong.count
        if !wrong.isEmpty { score.damagedItems += 1 }
        if arguments.has("verbose") {
          for substitution in wrong {
            emit([
              "type": "falsePositive", "threshold": threshold, "item": record.index,
              "kind": record.kind.rawValue, "before": substitution.before,
              "after": substitution.after, "score": substitution.score,
            ])
          }
        }
      case .prose, .free:
        // No identifiers were spoken, so every substitution is damage.
        score.falsePositives += result.substitutions.count
        if !result.substitutions.isEmpty { score.damagedItems += 1 }
        for substitution in result.substitutions {
          emit([
            "type": "falsePositive", "threshold": threshold, "item": record.index,
            "kind": record.kind.rawValue, "before": substitution.before,
            "after": substitution.after, "score": substitution.score,
          ])
        }
      }
    }

    emit([
      "type": "threshold",
      "threshold": threshold,
      "recall": score.expected > 0 ? Double(score.recovered) / Double(score.expected) : 0,
      "recovered": score.recovered,
      "expected": score.expected,
      "falsePositives": score.falsePositives,
      "damagedItems": score.damagedItems,
      "items": records.count,
      "vocabularySize": vocabulary.count,
    ])
  }
}
