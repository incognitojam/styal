import AVFoundation
import Foundation

// Corpus recorder: one utterance at a time, each saved with its expected output.
//
// Deliberately not synthetic. `say` pronounces "useMemo" as an invented word,
// whereas a person says "use memo" — TTS would test a transcription problem we
// do not have, and it is acoustically too clean besides (finding 1a).

struct CorpusItem {
  enum Kind: String {
    /// Contains identifiers in code form. The prompt text is the expected output.
    case code
    /// Plain English negative control. Must survive untouched.
    case prose
    /// Free-form speech on a topic. No ground truth.
    case free
  }

  let index: Int
  let kind: Kind
  /// What to read aloud, or the topic for free-form items.
  let say: String

  /// Expected matcher output. For scripted items this is the prompt itself —
  /// identifiers are shown as written in code, so correct output is unchanged
  /// text. Nil for free-form.
  var want: String? { kind == .free ? nil : say }

  var isNegativeControl: Bool { kind == .prose }
}

func parseCorpusScript(_ contents: String) -> [CorpusItem] {
  var items: [CorpusItem] = []

  for rawLine in contents.split(separator: "\n", omittingEmptySubsequences: false) {
    let line = rawLine.trimmingCharacters(in: .whitespaces)
    if line.isEmpty || line.hasPrefix("#") { continue }

    let prefixes: [(String, CorpusItem.Kind)] = [
      ("CODE:", .code), ("PROSE:", .prose), ("FREE:", .free),
    ]
    for (prefix, kind) in prefixes where line.hasPrefix(prefix) {
      let body = String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
      items.append(CorpusItem(index: items.count + 1, kind: kind, say: body))
      break
    }
  }
  return items
}

/// Records one utterance, returning peak level so silence is caught immediately
/// rather than surfacing as an empty transcript later (finding 4).
func recordUtterance(to url: URL) async throws -> Float {
  let engine = AVAudioEngine()
  let input = engine.inputNode
  let format = input.outputFormat(forBus: 0)
  let sink = try RecordingSink(url: url, format: format)

  input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
    sink.write(buffer)
  }
  engine.prepare()
  try engine.start()
  await waitForEnter()
  engine.stop()
  input.removeTap(onBus: 0)

  return sink.peakDecibels
}
