import AVFoundation
import Dispatch
import Foundation

let captureRate = 16_000.0
let playbackRate = 48_000.0
let playbackFrames: AVAudioFrameCount = 960

final class AudioHost {
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let captureFormat = AVAudioFormat(standardFormatWithSampleRate: captureRate, channels: 1)!
  private let playbackFormat = AVAudioFormat(standardFormatWithSampleRate: playbackRate, channels: 1)!
  private let stdout = FileHandle.standardOutput
  private let stdoutQueue = DispatchQueue(label: "voxstudio.audio.stdout")
  private var converter: AVAudioConverter?
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
    converter = AVAudioConverter(from: sourceFormat, to: captureFormat)
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
      chunk.withUnsafeBytes { source in
        destination.update(from: source.baseAddress!.assumingMemoryBound(to: Float.self), count: Int(playbackFrames))
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
    guard let converter else { return }
    let capacity = AVAudioFrameCount(Double(input.frameLength) * captureRate / input.format.sampleRate) + 8
    guard let output = AVAudioPCMBuffer(pcmFormat: captureFormat, frameCapacity: capacity) else { return }
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return input
    }
    guard status != .error, error == nil, output.frameLength > 0, let samples = output.floatChannelData?[0] else { return }
    if captureDiagnostics < 3 {
      var energy: Float = 0
      for index in 0..<Int(output.frameLength) { energy += samples[index] * samples[index] }
      let level = sqrt(energy / Float(output.frameLength))
      fputs("vox-audio-host capture frames=\(output.frameLength) rms=\(level)\n", stderr)
      captureDiagnostics += 1
    }
    let data = Data(bytes: samples, count: Int(output.frameLength) * MemoryLayout<Float>.size)
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
