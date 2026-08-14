@preconcurrency import AVFoundation
import Foundation

enum AudioError: Error, CustomStringConvertible {
  case converterUnavailable(from: AVAudioFormat, to: AVAudioFormat)
  case conversionFailed(String)
  case noCompatibleFormat
  case allocationFailed

  var description: String {
    switch self {
    case let .converterUnavailable(from, to):
      return "no AVAudioConverter from \(from) to \(to)"
    case let .conversionFailed(message):
      return "audio conversion failed: \(message)"
    case .noCompatibleFormat:
      return "SpeechAnalyzer reported no compatible audio format"
    case .allocationFailed:
      return "could not allocate a PCM buffer"
    }
  }
}

/// Resamples microphone/file buffers into whatever format `SpeechAnalyzer`
/// asks for. The converter is stateful across calls so sample-rate conversion
/// stays continuous; callers must use one instance per audio stream.
///
/// `@unchecked Sendable` because the only caller is a serial audio tap.
final class BufferConverter: @unchecked Sendable {
  private var converter: AVAudioConverter?

  func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
    let inputFormat = buffer.format
    if inputFormat == format { return buffer }

    if converter == nil || converter?.inputFormat != inputFormat || converter?.outputFormat != format {
      guard let made = AVAudioConverter(from: inputFormat, to: format) else {
        throw AudioError.converterUnavailable(from: inputFormat, to: format)
      }
      // Without this the converter injects leading silence, which shows up as
      // a dropped first syllable.
      made.primeMethod = .none
      converter = made
    }
    guard let converter else { throw AudioError.converterUnavailable(from: inputFormat, to: format) }

    let ratio = format.sampleRate / inputFormat.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1024
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
      throw AudioError.allocationFailed
    }

    // The input block runs synchronously inside `convert`, so this is not
    // actually concurrent despite the closure's @Sendable signature.
    nonisolated(unsafe) var consumed = false
    var conversionError: NSError?
    let status = converter.convert(to: output, error: &conversionError) { _, outStatus in
      if consumed {
        outStatus.pointee = .noDataNow
        return nil
      }
      consumed = true
      outStatus.pointee = .haveData
      return buffer
    }

    if status == .error {
      throw AudioError.conversionFailed(conversionError?.localizedDescription ?? "unknown")
    }
    return output
  }
}

/// Peak amplitude of a buffer in dBFS. Returns -.infinity for digital silence.
func peakDecibels(of buffer: AVAudioPCMBuffer) -> Float {
  guard let channels = buffer.floatChannelData else { return -.infinity }
  var peak: Float = 0
  for channel in 0..<Int(buffer.format.channelCount) {
    let samples = channels[channel]
    for frame in 0..<Int(buffer.frameLength) {
      peak = max(peak, abs(samples[frame]))
    }
  }
  return peak > 0 ? 20 * log10(peak) : -.infinity
}

/// Thread-safe sink for writing tap buffers to disk, tracking peak amplitude so
/// callers can tell "recorded silence" from "recorded nothing".
final class RecordingSink: @unchecked Sendable {
  private let file: AVAudioFile
  private let lock = NSLock()
  private var peakAmplitude: Float = 0

  init(url: URL, format: AVAudioFormat) throws {
    // AVAudioEngine always reports a non-interleaved input format, but files
    // cannot be non-interleaved. Passing format.settings through verbatim makes
    // AVAudioFile log a warning on every recording; writes convert regardless.
    var settings = format.settings
    settings[AVLinearPCMIsNonInterleaved] = false
    file = try AVAudioFile(forWriting: url, settings: settings)
  }

  var peak: Float {
    lock.lock()
    defer { lock.unlock() }
    return peakAmplitude
  }

  /// Peak in dBFS. Returns -.infinity for digital silence.
  var peakDecibels: Float {
    let value = peak
    return value > 0 ? 20 * log10(value) : -.infinity
  }

  func write(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    defer { lock.unlock() }
    try? file.write(from: buffer)

    guard let channels = buffer.floatChannelData else { return }
    for channel in 0..<Int(buffer.format.channelCount) {
      let samples = channels[channel]
      for frame in 0..<Int(buffer.frameLength) {
        peakAmplitude = max(peakAmplitude, abs(samples[frame]))
      }
    }
  }
}
