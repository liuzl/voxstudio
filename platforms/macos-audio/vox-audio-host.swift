import AVFoundation
import Dispatch
import Foundation

let captureRate = 16_000.0
let playbackRate = 48_000.0
let playbackFrames: AVAudioFrameCount = 960

final class AudioHost {
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let playbackFormat = AVAudioFormat(standardFormatWithSampleRate: playbackRate, channels: 1)!
  private let stdout = FileHandle.standardOutput
  private let stdoutQueue = DispatchQueue(label: "voxstudio.audio.stdout")
  private var pendingPlayback = Data()
  private var captureDiagnostics = 0

  func start() throws {
    // Voice processing must be configured before the engine starts.
    try engine.inputNode.setVoiceProcessingEnabled(true)
    engine.attach(player)
    // Do not route through the default stereo mixer. Voice Processing I/O
    // aggregates capture and render devices and fails initialization when the
    // render graph advertises a different channel count than the mono mic.
    engine.connect(player, to: engine.outputNode, format: playbackFormat)
    let input = engine.inputNode
    let sourceFormat = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 960, format: sourceFormat) { [weak self] buffer, _ in
      self?.capture(buffer)
    }
    engine.prepare()
    try engine.start()
    player.play()
    fputs("vox-audio-host ready voice-processing=\(input.isVoiceProcessingEnabled) capture=\(sourceFormat.sampleRate)Hz/\(sourceFormat.channelCount)ch\n", stderr)
  }

  func appendPlayback(_ data: Data) {
    pendingPlayback.append(data)
    let bytesPerBuffer = Int(playbackFrames) * MemoryLayout<Float>.size
    while pendingPlayback.count >= bytesPerBuffer {
      let chunk = pendingPlayback.prefix(bytesPerBuffer)
      pendingPlayback.removeFirst(bytesPerBuffer)
      guard let buffer = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: playbackFrames),
            let destination = buffer.floatChannelData?[0] else { return }
      buffer.frameLength = playbackFrames
      _ = chunk.withUnsafeBytes { source in
        // Data slices are not guaranteed to be Float-aligned on Apple Silicon.
        // Copy raw bytes rather than binding an unaligned pointer to Float.
        memcpy(destination, source.baseAddress!, bytesPerBuffer)
      }
      player.scheduleBuffer(buffer)
    }
  }

  func clearPlayback() {
    pendingPlayback.removeAll(keepingCapacity: true)
    player.stop()
    player.play()
  }

  func stop() {
    engine.inputNode.removeTap(onBus: 0)
    player.stop()
    engine.stop()
  }

  private func capture(_ input: AVAudioPCMBuffer) {
    if captureDiagnostics < 3, let channels = input.floatChannelData {
      let levels = (0..<Int(input.format.channelCount)).map { channel -> String in
        var energy: Float = 0
        for index in 0..<Int(input.frameLength) { energy += channels[channel][index] * channels[channel][index] }
        return String(format: "%.5f", sqrt(energy / Float(input.frameLength)))
      }
      fputs("vox-audio-host source-rms=[\(levels.joined(separator: ","))]\n", stderr)
    }
    guard let channels = input.floatChannelData,
          input.format.sampleRate == 48_000 else { return }
    // Voice Processing exposes a 9-channel aggregate on this hardware. Each
    // channel carries the same processed capture signal; AVAudioConverter's
    // 9-to-1 path returns silence, so select one channel and decimate 3:1.
    let outputCount = Int(input.frameLength) / 3
    guard outputCount > 0 else { return }
    var output = [Float](repeating: 0, count: outputCount)
    for index in 0..<outputCount { output[index] = channels[0][index * 3] }
    let samples = output
    if captureDiagnostics < 3 {
      var energy: Float = 0
      for sample in samples { energy += sample * sample }
      let level = sqrt(energy / Float(samples.count))
      fputs("vox-audio-host capture frames=\(samples.count) rms=\(level)\n", stderr)
      captureDiagnostics += 1
    }
    let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
    stdoutQueue.async { self.stdout.write(data) }
  }
}

let host = AudioHost()
let signalQueue = DispatchQueue.main
signal(SIGUSR1, SIG_IGN)
let clearSignal = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: signalQueue)
clearSignal.setEventHandler { host.clearPlayback() }
clearSignal.resume()

do {
  try host.start()
  FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty {
      handle.readabilityHandler = nil
      host.stop()
      exit(0)
    }
    signalQueue.async { host.appendPlayback(data) }
  }
  RunLoop.main.run()
} catch {
  fputs("vox-audio-host error: \(error)\n", stderr)
  exit(1)
}
