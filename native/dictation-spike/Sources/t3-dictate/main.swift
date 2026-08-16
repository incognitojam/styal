import AVFoundation
import CryptoKit
import Foundation
import FoundationModels
import Speech

// Spike: mic/file -> SpeechAnalyzer -> JSONL on stdout.
//
// Exists to answer three questions that reading docs cannot:
//   1. Is there a real limit on AnalysisContext.contextualStrings?
//   2. What does ReportingOption.fastResults buy?
//   3. Does the model handle camelCase identifiers well enough to matter?
//
// Diagnostics go to stderr, results to stdout, so `t3-dictate file ... > out.jsonl`
// stays clean for diffing A/B runs.

// MARK: - Output

func log(_ message: String) {
  FileHandle.standardError.write(Data("[t3-dictate] \(message)\n".utf8))
}

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String) -> Never {
  log("error: \(message)")
  exit(1)
}

// MARK: - Arguments

struct Arguments {
  let command: String
  private let values: [String: String]
  private let flags: Set<String>

  init(_ argv: [String]) {
    var values: [String: String] = [:]
    var flags: Set<String> = []
    var command = "help"

    var index = 0
    while index < argv.count {
      let token = argv[index]
      if token.hasPrefix("--") {
        let key = String(token.dropFirst(2))
        let next = index + 1 < argv.count ? argv[index + 1] : nil
        if let next, !next.hasPrefix("--") {
          values[key] = next
          index += 2
          continue
        }
        flags.insert(key)
      } else if command == "help" {
        command = token
      }
      index += 1
    }

    self.command = command
    self.values = values
    self.flags = flags
  }

  func string(_ key: String) -> String? { values[key] }
  func int(_ key: String) -> Int? { values[key].flatMap(Int.init) }
  func double(_ key: String) -> Double? { values[key].flatMap(Double.init) }
  func has(_ key: String) -> Bool { flags.contains(key) }
}

let arguments = Arguments(Array(CommandLine.arguments.dropFirst()))
let locale = Locale(identifier: arguments.string("locale") ?? "en-US")
let wantsFast = arguments.has("fast")
let wantsAlternatives = arguments.has("alternatives")

// MARK: - Vocabulary

func loadVocabulary() -> [String] {
  guard let path = arguments.string("vocab") else { return [] }
  guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else {
    fail("could not read vocab file at \(path)")
  }
  var seen = Set<String>()
  var terms: [String] = []
  for line in raw.split(separator: "\n") {
    let term = line.trimmingCharacters(in: .whitespaces)
    if term.isEmpty || seen.contains(term) { continue }
    seen.insert(term)
    terms.append(term)
  }
  if let limit = arguments.int("limit"), terms.count > limit {
    terms = Array(terms.prefix(limit))
  }
  return terms
}

// MARK: - Speech setup

func makeTranscriber(locale: Locale) -> SpeechTranscriber {
  var reporting: Set<SpeechTranscriber.ReportingOption> = [.volatileResults]
  if wantsFast { reporting.insert(.fastResults) }
  if wantsAlternatives { reporting.insert(.alternativeTranscriptions) }
  return SpeechTranscriber(
    locale: locale,
    // Deliberately no .etiquetteReplacements — that is profanity masking and
    // would mangle legitimate words.
    transcriptionOptions: [],
    reportingOptions: reporting,
    attributeOptions: [.transcriptionConfidence]
  )
}

// MARK: - Custom language model

let modelIdentifier = "dev.incognitojam.t3code.dictation"

/// Sentence frames a developer dictates identifiers into. `<symbol>` expands
/// against the extracted vocabulary.
let dictationTemplates = [
  "the <symbol>",
  "a <symbol>",
  "call <symbol>",
  "use <symbol>",
  "read the <symbol>",
  "check the <symbol>",
  "update the <symbol>",
  "set the <symbol>",
  "pass the <symbol>",
  "from the <symbol>",
  "on the <symbol>",
  "in the <symbol>",
  "needs the <symbol>",
  "returns the <symbol>",
  "<symbol> and <symbol>",
  "the <symbol> of the <symbol>",
]

/// Stable across processes, unlike `String.hashValue`. Doubles as the `version`
/// field, which is what lets `prepareCustomLanguageModel` reuse a cached build.
func fingerprint(_ terms: [String]) -> String {
  let digest = SHA256.hash(data: Data(terms.joined(separator: "\n").utf8))
  return digest.map { String(format: "%02x", $0) }.joined().prefix(16).description
}

struct CustomModelPaths {
  let directory: URL
  var asset: URL { directory.appendingPathComponent("training.bin") }
  var languageModel: URL { directory.appendingPathComponent("model.lm") }
  var vocabulary: URL { directory.appendingPathComponent("vocab.lm") }

  func configuration(weight: Double?) -> SFSpeechLanguageModel.Configuration {
    SFSpeechLanguageModel.Configuration(
      languageModel: languageModel,
      vocabulary: vocabulary,
      weight: weight.map(NSNumber.init(value:))
    )
  }
}

func fileSize(_ url: URL) -> Int {
  (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) as? Int ?? 0
}

func runTrain() async throws {
  let vocabulary = loadVocabulary()
  guard !vocabulary.isEmpty else { fail("train requires --vocab <file>") }
  guard let out = arguments.string("out") else { fail("train requires --out <dir>") }
  let resolved = await resolveLocale(locale)
  let phraseCount = arguments.int("phrase-count") ?? 10

  let paths = CustomModelPaths(directory: URL(fileURLWithPath: out))
  try FileManager.default.createDirectory(at: paths.directory, withIntermediateDirectories: true)

  let version = fingerprint(vocabulary + [arguments.has("templates") ? "templates" : ""])
  let data = SFCustomLanguageModelData(locale: resolved, identifier: modelIdentifier, version: version)

  if arguments.has("templates") {
    // Bare unigrams do not shift an n-gram model. Templates place each symbol in
    // the sentence positions a developer actually dictates it in.
    let generator = SFCustomLanguageModelData.TemplatePhraseCountGenerator()
    generator.define(className: "symbol", values: vocabulary)
    for template in dictationTemplates {
      generator.insert(template: template, count: phraseCount)
    }
    data.insert(phraseCountGenerator: generator)
  } else {
    for term in vocabulary {
      data.insert(phraseCount: .init(phrase: term, count: phraseCount))
    }
  }

  let exportStarted = Date()
  try await data.export(to: paths.asset)
  let exportMs = Date().timeIntervalSince(exportStarted) * 1000

  let prepareStarted = Date()
  // The deprecated overload takes a clientIdentifier, which plausibly scopes the
  // model to a bundle identifier — this binary has no bundle at all.
  if let client = arguments.string("client-identifier") {
    try await SFSpeechLanguageModel.prepareCustomLanguageModel(
      for: paths.asset,
      clientIdentifier: client,
      configuration: paths.configuration(weight: arguments.double("weight")),
      ignoresCache: true
    )
  } else {
    try await SFSpeechLanguageModel.prepareCustomLanguageModel(
      for: paths.asset,
      configuration: paths.configuration(weight: arguments.double("weight")),
      ignoresCache: true
    )
  }
  let prepareMs = Date().timeIntervalSince(prepareStarted) * 1000

  emit([
    "type": "train",
    "locale": resolved.identifier,
    "version": version,
    "terms": vocabulary.count,
    "phraseCount": phraseCount,
    "exportMs": exportMs,
    "prepareMs": prepareMs,
    "assetBytes": fileSize(paths.asset),
    "languageModelBytes": fileSize(paths.languageModel),
    "vocabularyBytes": fileSize(paths.vocabulary),
    "directory": paths.directory.path,
  ])
}

/// `DictationTranscriber` is the only module that honours contextualStrings, but
/// its default presets drop punctuation, so build it explicitly.
func makeDictationTranscriber(locale: Locale) -> DictationTranscriber {
  if let preset = arguments.string("dictation-preset") {
    let presets: [String: DictationTranscriber.Preset] = [
      "phrase": .phrase,
      "shortDictation": .shortDictation,
      "progressiveShortDictation": .progressiveShortDictation,
      "longDictation": .longDictation,
      "progressiveLongDictation": .progressiveLongDictation,
      "timeIndexedLongDictation": .timeIndexedLongDictation,
    ]
    guard let resolved = presets[preset] else {
      fail("unknown --dictation-preset \(preset); one of \(presets.keys.sorted().joined(separator: ", "))")
    }
    return DictationTranscriber(locale: locale, preset: resolved)
  }

  var transcription: Set<DictationTranscriber.TranscriptionOption> = []
  if !arguments.has("no-punctuation") { transcription.insert(.punctuation) }
  if arguments.has("emoji") { transcription.insert(.emoji) }

  var reporting: Set<DictationTranscriber.ReportingOption> = [.volatileResults]
  if arguments.has("fast") { reporting.insert(.frequentFinalization) }
  if wantsAlternatives { reporting.insert(.alternativeTranscriptions) }

  var hints: Set<DictationTranscriber.ContentHint> = []
  if let customModel = arguments.string("custom-lm") {
    let paths = CustomModelPaths(directory: URL(fileURLWithPath: customModel))
    guard FileManager.default.fileExists(atPath: paths.languageModel.path) else {
      fail("no compiled model at \(paths.languageModel.path) — run `train --out \(customModel)` first")
    }
    hints.insert(.customizedLanguage(modelConfiguration: paths.configuration(weight: arguments.double("weight"))))
  }
  if arguments.has("short-form") { hints.insert(.shortForm) }

  return DictationTranscriber(
    locale: locale,
    contentHints: hints,
    transcriptionOptions: transcription,
    reportingOptions: reporting,
    attributeOptions: []
  )
}

func resolveLocale(_ requested: Locale) async -> Locale {
  guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
    fail("locale \(requested.identifier) is not supported by SpeechTranscriber")
  }
  return supported
}

func ensureModelInstalled(for transcriber: SpeechTranscriber) async throws {
  guard SpeechTranscriber.isAvailable else {
    fail("SpeechTranscriber is unavailable on this device")
  }
  let status = await AssetInventory.status(forModules: [transcriber])
  guard status != .installed else { return }
  log("model assets not installed (status: \(describe(status))) — downloading…")
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
    try await request.downloadAndInstall()
    log("model assets installed")
  }
}

// MARK: - Microphone permission

func describeMicrophoneAuthorization() -> String {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

/// macOS hands back digital silence rather than an error when microphone access
/// is refused, so check up front instead of producing a mysteriously empty
/// transcript. Note the grant belongs to the *parent* app (Terminal, iTerm, the
/// editor you launched this from), not to this binary.
func ensureMicrophoneAccess() async {
  let status = AVCaptureDevice.authorizationStatus(for: .audio)
  if status == .notDetermined {
    log("requesting microphone access…")
    _ = await AVCaptureDevice.requestAccess(for: .audio)
  }
  guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
    fail("""
      microphone access is \(describeMicrophoneAuthorization()).

      The grant applies to whichever app launched this binary. Enable it under
      System Settings › Privacy & Security › Microphone, then run again.

      If you launched this from a terminal embedded in an app without
      NSMicrophoneUsageDescription (T3 Code's built-in terminal, for example),
      no prompt can appear at all — use Terminal.app or iTerm instead.
      """)
  }
}

func describe(_ status: AssetInventory.Status) -> String {
  switch status {
  case .unsupported: return "unsupported"
  case .supported: return "supported"
  case .downloading: return "downloading"
  case .installed: return "installed"
  @unknown default: return "unknown"
  }
}

struct TranscriptionRun {
  var text: String = ""
  var volatileCount: Int = 0
  var finalCount: Int = 0
  var firstResultMs: Double?
  var firstFinalMs: Double?
}

/// The two transcriber modules produce different result types that share no
/// protocol carrying `text`, so give them one.
protocol TextualSpeechResult: SpeechModuleResult {
  var text: AttributedString { get }
}

extension SpeechTranscriber.Result: TextualSpeechResult {}
extension DictationTranscriber.Result: TextualSpeechResult {}

/// Drains a module's results until the analyzer finishes.
/// `onUpdate` fires for every result so live mode can stream.
func collectResults<Results: AsyncSequence & Sendable>(
  from results: Results,
  startedAt: Date,
  onUpdate: (@Sendable (_ text: String, _ isFinal: Bool) -> Void)? = nil
) -> Task<TranscriptionRun, Error> where Results.Element: TextualSpeechResult {
  Task {
    var run = TranscriptionRun()
    for try await result in results {
      let elapsed = Date().timeIntervalSince(startedAt) * 1000
      let text = String(result.text.characters)
      if run.firstResultMs == nil { run.firstResultMs = elapsed }
      if result.isFinal {
        if run.firstFinalMs == nil { run.firstFinalMs = elapsed }
        run.finalCount += 1
        run.text += text
      } else {
        run.volatileCount += 1
      }
      onUpdate?(text, result.isFinal)
    }
    return run
  }
}

// MARK: - Commands

func runInfo() async {
  let supported = await SpeechTranscriber.supportedLocales
  let installed = await SpeechTranscriber.installedLocales
  let equivalent = await SpeechTranscriber.supportedLocale(equivalentTo: locale)
  let transcriber = makeTranscriber(locale: equivalent ?? locale)
  let status = await AssetInventory.status(forModules: [transcriber])
  let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])

  emit([
    "type": "info",
    "isAvailable": SpeechTranscriber.isAvailable,
    "microphoneAuthorization": describeMicrophoneAuthorization(),
    "requestedLocale": locale.identifier,
    "resolvedLocale": equivalent?.identifier ?? NSNull(),
    "assetStatus": describe(status),
    "supportedLocaleCount": supported.count,
    "installedLocales": installed.map(\.identifier),
    "maximumReservedLocales": AssetInventory.maximumReservedLocales,
    "analyzerFormat": format.map { "\($0.sampleRate)Hz ch=\($0.channelCount) \($0.commonFormat.rawValue)" } ?? NSNull(),
  ])
}

func runRecord() async throws {
  guard let output = arguments.string("out") else { fail("record requires --out <path.wav>") }
  await ensureMicrophoneAccess()
  let seconds = arguments.double("seconds")
  let engine = AVAudioEngine()
  let input = engine.inputNode
  let format = input.outputFormat(forBus: 0)
  let sink = try RecordingSink(url: URL(fileURLWithPath: output), format: format)

  input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
    sink.write(buffer)
  }
  engine.prepare()
  try engine.start()

  if let seconds {
    log("recording \(seconds)s to \(output)…")
    try await Task.sleep(for: .seconds(seconds))
  } else {
    log("recording to \(output) — press Enter to stop")
    await waitForEnter()
  }

  engine.stop()
  input.removeTap(onBus: 0)

  let peak = sink.peakDecibels
  guard peak > -80 else {
    fail("""
      recorded \(output) but it is digital silence (peak \(peak) dBFS).

      Microphone access reports \(describeMicrophoneAuthorization()), so this is
      most likely the wrong input device, or a parent app holding a stale grant.
      Check System Settings › Sound › Input, then re-run from Terminal.app.
      """)
  }
  log(String(format: "saved %@ (peak %.1f dBFS)", output, peak))
}

func runFile() async throws {
  guard let input = arguments.string("input") else { fail("file requires --input <path.wav>") }
  let vocabulary = loadVocabulary()
  let resolved = await resolveLocale(locale)
  let transcriber = makeTranscriber(locale: resolved)
  try await ensureModelInstalled(for: transcriber)

  let context = AnalysisContext()
  if !vocabulary.isEmpty {
    context.contextualStrings[.general] = vocabulary
  }

  // Does DictationTranscriber honour contextualStrings where SpeechTranscriber
  // ignores them? It is the module that also exposes the custom-language-model
  // content hint, so it is the one plausibly wired for vocabulary.
  let dictation = arguments.has("dictation") ? makeDictationTranscriber(locale: resolved) : nil
  let modules: [any SpeechModule] = dictation.map { [$0] } ?? [transcriber]

  guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules) else {
    throw AudioError.noCompatibleFormat
  }

  let audioFile = try AVAudioFile(forReading: URL(fileURLWithPath: input))
  let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
  let analyzer = SpeechAnalyzer(inputSequence: stream, modules: modules, analysisContext: context)

  // Diagnostic: does the analyzer actually retain what we handed it? Distinguishes
  // "the API rejected our vocabulary" from "the module ignores it".
  if arguments.has("set-context") {
    try await analyzer.setContext(context)
  }
  if arguments.has("verify-context") {
    let stored = await analyzer.context.contextualStrings[.general] ?? []
    log("context readback: \(stored.count) terms, first 3: \(stored.prefix(3).joined(separator: ", "))")
  }

  let startedAt = Date()
  let collector = dictation.map { collectResults(from: $0.results, startedAt: startedAt) }
    ?? collectResults(from: transcriber.results, startedAt: startedAt)

  let converter = BufferConverter()
  let chunkSize: AVAudioFrameCount = 4096
  var inputPeak: Float = -.infinity
  while audioFile.framePosition < audioFile.length {
    guard let buffer = AVAudioPCMBuffer(pcmFormat: audioFile.processingFormat, frameCapacity: chunkSize) else {
      throw AudioError.allocationFailed
    }
    try audioFile.read(into: buffer, frameCount: chunkSize)
    if buffer.frameLength == 0 { break }
    inputPeak = max(inputPeak, peakDecibels(of: buffer))
    continuation.yield(AnalyzerInput(buffer: try converter.convert(buffer, to: analyzerFormat)))
  }
  continuation.finish()

  if inputPeak <= -80 {
    fail("\(input) is digital silence (peak \(inputPeak) dBFS) — nothing to transcribe")
  }
  try await analyzer.finalizeAndFinishThroughEndOfInput()

  let run = try await collector.value
  let audioSeconds = Double(audioFile.length) / audioFile.processingFormat.sampleRate
  let wallMs = Date().timeIntervalSince(startedAt) * 1000

  emit([
    "type": "transcript",
    "text": run.text.trimmingCharacters(in: .whitespacesAndNewlines),
    "locale": resolved.identifier,
    "vocabularySize": vocabulary.count,
    "fastResults": wantsFast,
    "audioSeconds": audioSeconds,
    "wallMs": wallMs,
    "realtimeFactor": audioSeconds > 0 ? (wallMs / 1000) / audioSeconds : 0,
    "firstResultMs": run.firstResultMs ?? NSNull(),
    "firstFinalMs": run.firstFinalMs ?? NSNull(),
    "volatileResults": run.volatileCount,
    "finalResults": run.finalCount,
  ])
}

func runLive() async throws {
  await ensureMicrophoneAccess()
  let vocabulary = loadVocabulary()
  let resolved = await resolveLocale(locale)
  let transcriber = makeTranscriber(locale: resolved)
  try await ensureModelInstalled(for: transcriber)

  let context = AnalysisContext()
  if !vocabulary.isEmpty {
    context.contextualStrings[.general] = vocabulary
  }

  guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
    throw AudioError.noCompatibleFormat
  }

  let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
  let analyzer = SpeechAnalyzer(inputSequence: stream, modules: [transcriber], analysisContext: context)

  let startedAt = Date()
  let collector = collectResults(from: transcriber.results, startedAt: startedAt) { text, isFinal in
    emit([
      "type": isFinal ? "final" : "volatile",
      "text": text,
      "atMs": Date().timeIntervalSince(startedAt) * 1000,
    ])
  }

  let engine = AVAudioEngine()
  let input = engine.inputNode
  let inputFormat = input.outputFormat(forBus: 0)
  let converter = BufferConverter()

  input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
    guard let converted = try? converter.convert(buffer, to: analyzerFormat) else { return }
    continuation.yield(AnalyzerInput(buffer: converted))
  }
  engine.prepare()
  try engine.start()

  log("listening (vocab: \(vocabulary.count) terms, fast: \(wantsFast)) — press Enter to stop")
  await waitForEnter()

  engine.stop()
  input.removeTap(onBus: 0)
  continuation.finish()
  try await analyzer.finalizeAndFinishThroughEndOfInput()

  let run = try await collector.value
  emit([
    "type": "transcript",
    "text": run.text.trimmingCharacters(in: .whitespacesAndNewlines),
    "vocabularySize": vocabulary.count,
    "fastResults": wantsFast,
    "firstResultMs": run.firstResultMs ?? NSNull(),
    "volatileResults": run.volatileCount,
    "finalResults": run.finalCount,
  ])
}

func runClean() async throws {
  let transcript: String
  if let path = arguments.string("text") {
    guard let contents = try? String(contentsOfFile: path, encoding: .utf8) else {
      fail("could not read transcript at \(path)")
    }
    transcript = contents.trimmingCharacters(in: .whitespacesAndNewlines)
  } else {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    transcript = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  }
  guard !transcript.isEmpty else { fail("clean requires a transcript via --text <path> or stdin") }

  let vocabulary = loadVocabulary()
  let engine = arguments.string("engine") ?? "foundation"

  switch engine {
  case "foundation":
    let result = try await cleanWithFoundationModels(
      transcript: transcript,
      vocabulary: vocabulary,
      prewarm: arguments.has("prewarm")
    )
    emit([
      "type": "clean",
      "engine": engine,
      "text": result.text,
      "prewarmMs": result.prewarmMs,
      "ms": result.respondMs,
      "vocabularySize": vocabulary.count,
    ])
  case "claude", "codex", "opencode":
    // Defaults are heavyweight (opus[1m]; gpt-5.6-terra at xhigh reasoning), which
    // says nothing useful about a cleanup task. Always pin the model.
    var extra = engine == "codex" ? ["exec"] : ["-p"]
    if let model = arguments.string("model") {
      extra += engine == "codex" ? ["-m", model] : ["--model", model]
    }
    if engine == "codex", let reasoning = arguments.string("reasoning") {
      extra += ["-c", "model_reasoning_effort=\"\(reasoning)\""]
    }
    let result = try cleanWithCommand(engine, arguments: extra, transcript: transcript, vocabulary: vocabulary)
    emit([
      "type": "clean",
      "engine": engine,
      "model": arguments.string("model") ?? "(default)",
      "reasoning": arguments.string("reasoning") ?? "(default)",
      "text": result.text,
      "ms": result.ms,
      "vocabularySize": vocabulary.count,
    ])
  default:
    fail("unknown --engine \(engine); one of foundation, claude, codex, opencode")
  }
}

/// Full pipeline: audio -> SpeechTranscriber -> per-utterance cleanup -> assembled
/// text. Cleans each sentence separately, which is both the regime the on-device
/// model handles reliably and what streaming naturally produces.
func runPipeline() async throws {
  guard let input = arguments.string("input") else { fail("pipeline requires --input <audio>") }
  let vocabulary = loadVocabulary()
  let resolved = await resolveLocale(locale)
  let transcriber = makeTranscriber(locale: resolved)
  try await ensureModelInstalled(for: transcriber)

  guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
    throw AudioError.noCompatibleFormat
  }

  let audioFile = try AVAudioFile(forReading: URL(fileURLWithPath: input))
  let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
  let analyzer = SpeechAnalyzer(inputSequence: stream, modules: [transcriber])

  let transcribeStarted = Date()
  let collector = collectResults(from: transcriber.results, startedAt: transcribeStarted)

  let converter = BufferConverter()
  let chunkSize: AVAudioFrameCount = 4096
  while audioFile.framePosition < audioFile.length {
    guard let buffer = AVAudioPCMBuffer(pcmFormat: audioFile.processingFormat, frameCapacity: chunkSize) else {
      throw AudioError.allocationFailed
    }
    try audioFile.read(into: buffer, frameCount: chunkSize)
    if buffer.frameLength == 0 { break }
    continuation.yield(AnalyzerInput(buffer: try converter.convert(buffer, to: analyzerFormat)))
  }
  continuation.finish()
  try await analyzer.finalizeAndFinishThroughEndOfInput()

  let run = try await collector.value
  let transcribeMs = Date().timeIntervalSince(transcribeStarted) * 1000
  let raw = run.text.trimmingCharacters(in: .whitespacesAndNewlines)

  let model = SystemLanguageModel(guardrails: .permissiveContentTransformations)
  guard model.isAvailable else {
    fail("on-device model is \(describeAvailability(model.availability))")
  }

  let segments = splitIntoSentences(raw)
  var cleaned: [String] = []
  var slowestMs: Double = 0
  var totalCleanupMs: Double = 0
  var rejected = 0

  for segment in segments {
    let result = await cleanSegment(segment, vocabulary: vocabulary, model: model)
    cleaned.append(result.text)
    slowestMs = max(slowestMs, result.ms)
    totalCleanupMs += result.ms
    if !result.accepted { rejected += 1 }
    emit([
      "type": "segment",
      "ms": result.ms,
      "accepted": result.accepted,
      "reason": result.reason ?? NSNull(),
      "before": segment,
      "after": result.text,
    ])
  }

  emit([
    "type": "pipeline",
    "raw": raw,
    "cleaned": cleaned.joined(separator: " "),
    "segments": segments.count,
    "rejectedSegments": rejected,
    "transcribeMs": transcribeMs,
    "cleanupTotalMs": totalCleanupMs,
    // What the user actually waits for: everything but the last segment is cleaned
    // while they are still speaking.
    "perceivedTailMs": slowestMs,
    "vocabularySize": vocabulary.count,
  ])
}

/// Deterministic identifier recovery, with a threshold sweep so precision and
/// recall can be eyeballed against the same fixture.
func runMatch() async throws {
  let text: String
  if let path = arguments.string("text") {
    guard let contents = try? String(contentsOfFile: path, encoding: .utf8) else {
      fail("could not read text at \(path)")
    }
    text = contents.trimmingCharacters(in: .whitespacesAndNewlines)
  } else {
    text = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  let vocabulary = buildVocabulary(loadVocabulary())
  guard !vocabulary.isEmpty else { fail("match requires --vocab <file>") }

  let thresholds = arguments.double("threshold").map { [$0] } ?? [0.60, 0.65, 0.70, 0.75]
  for threshold in thresholds {
    let started = Date()
    let result = applyVocabulary(
      to: text,
      vocabulary: vocabulary,
      threshold: threshold,
      useEditBudget: arguments.has("budget")
    )
    emit([
      "type": "match",
      "threshold": threshold,
      "microseconds": Date().timeIntervalSince(started) * 1_000_000,
      "substitutions": result.substitutions.map {
        ["before": $0.before, "after": $0.after, "score": $0.score]
      },
      "text": result.text,
    ])
  }
}

/// Walks a corpus script, recording one utterance per item, with redo support.
/// Resumable: items whose audio already exists are skipped.
func runCorpus() async throws {
  let scriptPath = arguments.string("script") ?? "corpus-script.txt"
  guard let contents = try? String(contentsOfFile: scriptPath, encoding: .utf8) else {
    fail("could not read corpus script at \(scriptPath)")
  }
  let outputDirectory = URL(fileURLWithPath: arguments.string("out") ?? "corpus")
  try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

  await ensureMicrophoneAccess()
  var items = parseCorpusScript(contents)
  guard !items.isEmpty else { fail("no items found in \(scriptPath)") }

  if let only = arguments.string("only") {
    guard let kind = CorpusItem.Kind(rawValue: only) else {
      fail("unknown --only \(only); one of code, prose, free")
    }
    items = items.filter { $0.kind == kind }
    log("filtered to \(items.count) \(only) items")
  }
  // Re-recording overwrites in place, so nothing has to be deleted by hand.
  let redo = arguments.has("redo")

  log("\(items.count) items. Enter starts a recording, Enter stops it.")
  log("After each: Enter to continue, r to redo, s to skip. Ctrl-C to stop — progress is kept.\n")

  for item in items {
    let audioURL = outputDirectory.appendingPathComponent(String(format: "%03d.aiff", item.index))
    let metadataURL = outputDirectory.appendingPathComponent(String(format: "%03d.json", item.index))

    if !redo, FileManager.default.fileExists(atPath: audioURL.path) {
      log("[\(item.index)] already recorded — skipping")
      continue
    }

    var done = false
    while !done {
      let banner = switch item.kind {
      case .free: "FREE-FORM — speak on this topic"
      case .prose: "CONTROL — read aloud"
      case .code: "READ ALOUD — say identifiers however comes naturally"
      }
      log("[\(item.index)] \(banner)")
      log("  \(item.say)")
      log("  press Enter to start recording…")
      await waitForEnter()

      log("  recording — press Enter when done")
      let peak = try await recordUtterance(to: audioURL)

      if peak <= -80 {
        log("  SILENT (peak \(peak) dBFS) — check the input device; retrying\n")
        try? FileManager.default.removeItem(at: audioURL)
        continue
      }

      log(String(format: "  saved (peak %.1f dBFS) — Enter to continue, r to redo, s to skip", peak))
      let answer = (readLine() ?? "").trimmingCharacters(in: .whitespaces).lowercased()
      if answer == "r" {
        try? FileManager.default.removeItem(at: audioURL)
        continue
      }
      if answer == "s" {
        try? FileManager.default.removeItem(at: audioURL)
        done = true
        continue
      }

      var metadata: [String: Any] = [
        "index": item.index,
        "kind": item.kind.rawValue,
        "say": item.say,
        "negativeControl": item.isNegativeControl,
      ]
      metadata["want"] = item.want ?? NSNull()
      if let data = try? JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys, .prettyPrinted]) {
        try? data.write(to: metadataURL)
      }
      done = true
      log("")
    }
  }

  log("corpus complete: \(outputDirectory.path)")
}

func waitForEnter() async {
  await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
    DispatchQueue.global().async {
      _ = readLine()
      continuation.resume()
    }
  }
}

func printUsage() {
  log("""
  usage: t3-dictate <command> [options]

  commands:
    info                          report availability, locales, asset status
    record --out <p> [--seconds n]  capture a fixed sample for A/B runs
    file --input <p>              transcribe a file (deterministic)
    live                          stream from the microphone

  options:
    --vocab <path>   newline-separated contextualStrings
    --limit <n>      truncate the vocab (for probing the phrase limit)
    --fast           add ReportingOption.fastResults
    --alternatives   add ReportingOption.alternativeTranscriptions
    --locale <id>    default en-US
  """)
}

// MARK: - Entry

do {
  switch arguments.command {
  case "info": await runInfo()
  case "record": try await runRecord()
  case "file": try await runFile()
  case "live": try await runLive()
  case "train": try await runTrain()
  case "clean": try await runClean()
  case "probe": try await runProbes()
  case "probe-guided": try await runGuidedProbe()
  case "pipeline": try await runPipeline()
  case "match": try await runMatch()
  case "corpus": try await runCorpus()
  case "eval": try await runEval()
  case "import": try await runImport()
  default: printUsage()
  }
} catch {
  fail("\(error)")
}
