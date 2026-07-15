/** The negotiated capture route, reported to the session per the duplex doc. */
export interface EndpointCapability {
  echoCancellation: boolean | undefined;
  noiseSuppression: boolean | undefined;
  autoGainControl: boolean | undefined;
  trackSampleRate: number | undefined;
  contextSampleRate: number;
}

/**
 * Streaming linear resampler: arbitrary input chunks in, continuous output at the target
 * rate, with one sample of carry so chunk boundaries do not click. Identity when the rates
 * already match.
 */
export class LinearResampler {
  /** Input samples advanced per output sample. */
  private readonly ratio: number;
  /** Unconsumed input: everything from the read head's left neighbor onward. */
  private tail = new Float32Array(0);
  /** Fractional read position within `tail`. */
  private offset = 0;

  constructor(fromRate: number, toRate: number) {
    if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
      throw new TypeError("sample rates must be positive finite numbers");
    }
    this.ratio = fromRate / toRate;
  }

  push(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input;
    const stream = new Float32Array(this.tail.length + input.length);
    stream.set(this.tail);
    stream.set(input, this.tail.length);
    const output: number[] = [];
    let position = this.offset;
    while (position + 1 < stream.length) {
      const index = Math.floor(position);
      const fraction = position - index;
      const a = stream[index] as number;
      const b = stream[index + 1] as number;
      output.push(a + (b - a) * fraction);
      position += this.ratio;
    }
    // Keep everything from the read head's left neighbor. The head may sit past the end
    // of the received input (a large ratio can overshoot); the overshoot must survive in
    // `offset`, not be truncated to its fraction, or the stream slowly stretches.
    const keep = Math.min(Math.floor(position), stream.length);
    this.tail = stream.slice(keep);
    this.offset = position - keep;
    return Float32Array.from(output);
  }
}

/**
 * Schedule math for gapless streamed playback: each chunk starts where the previous one
 * ends (or now plus a small lead when the queue ran dry), and the audible end is always
 * `remainingSec` away. Pure so the clock behavior is testable without an AudioContext.
 */
export class PlaybackTimeline {
  private readonly leadSec: number;
  private playheadSec = 0;

  constructor(leadSec = 0.05) {
    this.leadSec = leadSec;
  }

  schedule(durationSec: number, nowSec: number): number {
    const startAt = Math.max(nowSec + this.leadSec, this.playheadSec);
    this.playheadSec = startAt + durationSec;
    return startAt;
  }

  remainingSec(nowSec: number): number {
    return Math.max(0, this.playheadSec - nowSec);
  }

  reset(): void {
    this.playheadSec = 0;
  }
}

const captureWorklet = `
class VoxCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("vox-capture", VoxCapture);
`;

const targetRate = 16_000;
const frameSamples = 320; // 20ms at 16kHz, the granularity the CLI capture uses

/**
 * Microphone capture for the browser endpoint: getUserMedia with AEC/NS/AGC requested, an
 * AudioWorklet tap, and resampling to the protocol's 16kHz mono float32 frames. Mute
 * disables the track (the browser shows it) and drops frames.
 */
export interface MicCaptureOptions {
  /**
   * Request AEC/NS/AGC (the conversation route). Off for reference recording: a voice
   * sample wants the microphone's unprocessed signal, not one shaped for telephony.
   */
  processing?: boolean;
}

export class MicCapture {
  private readonly context: AudioContext;
  private readonly stream: MediaStream;
  private readonly node: AudioWorkletNode;
  private readonly resampler: LinearResampler;
  private buffered: Float32Array = new Float32Array(0);
  private muted = false;

  private constructor(context: AudioContext, stream: MediaStream, node: AudioWorkletNode, onFrame: (samples: Float32Array) => void) {
    this.context = context;
    this.stream = stream;
    this.node = node;
    this.resampler = new LinearResampler(context.sampleRate, targetRate);
    node.port.onmessage = event => {
      if (this.muted) return;
      const resampled = this.resampler.push(event.data as Float32Array);
      if (resampled.length === 0) return;
      const joined = new Float32Array(this.buffered.length + resampled.length);
      joined.set(this.buffered);
      joined.set(resampled, this.buffered.length);
      let offset = 0;
      while (joined.length - offset >= frameSamples) {
        onFrame(joined.slice(offset, offset + frameSamples));
        offset += frameSamples;
      }
      this.buffered = joined.slice(offset);
    };
  }

  static async start(onFrame: (samples: Float32Array) => void, options: MicCaptureOptions = {}): Promise<MicCapture> {
    const processing = options.processing ?? true;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: processing,
        noiseSuppression: processing,
        autoGainControl: processing,
        channelCount: 1,
      },
    });
    const context = new AudioContext({ sampleRate: targetRate });
    await context.resume();
    const workletUrl = URL.createObjectURL(new Blob([captureWorklet], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "vox-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
    source.connect(node);
    return new MicCapture(context, stream, node, onFrame);
  }

  /** The negotiated constraints snapshot the duplex doc requires the endpoint to report. */
  capability(): EndpointCapability {
    const settings = this.stream.getAudioTracks()[0]?.getSettings() ?? {};
    return {
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
      trackSampleRate: settings.sampleRate,
      contextSampleRate: this.context.sampleRate,
    };
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.stream.getAudioTracks()) track.enabled = !muted;
  }

  async stop(): Promise<void> {
    this.node.port.onmessage = null;
    this.node.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    await this.context.close();
  }
}

/**
 * Reference-audio recording for voice registration: the unprocessed microphone at the
 * protocol's 16kHz mono, collected until stop. The web counterpart of
 * `vox voices add <id> --record`.
 */
export class VoiceRecorder {
  private readonly mic: MicCapture;
  private readonly chunks: Float32Array[] = [];
  private readonly startedAtMs = Date.now();

  private constructor(mic: MicCapture) {
    this.mic = mic;
  }

  static async start(): Promise<VoiceRecorder> {
    let recorder: VoiceRecorder | undefined;
    const mic = await MicCapture.start(samples => {
      recorder?.chunks.push(samples);
    }, { processing: false });
    recorder = new VoiceRecorder(mic);
    return recorder;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAtMs;
  }

  /** Stop the microphone and return the recording as mono float32 at 16kHz. */
  async stop(): Promise<Float32Array> {
    await this.mic.stop();
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
}

/**
 * Reply audio out: gapless scheduling of streamed PCM chunks, immediate stop on
 * interruption, and the audible-end callback that drives `playback.complete` — the
 * endpoint-owned playback clock the protocol's playbackAck option exists for.
 */
export class SpeakerOutput {
  private readonly context: AudioContext;
  private readonly timeline = new PlaybackTimeline();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private sampleRate = 48_000;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.context = new AudioContext();
  }

  async resume(): Promise<void> {
    await this.context.resume();
  }

  setFormat(sampleRate: number): void {
    this.sampleRate = sampleRate;
  }

  enqueue(samples: Float32Array): void {
    if (samples.length === 0) return;
    const buffer = this.context.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => this.sources.delete(source);
    this.sources.add(source);
    source.start(this.timeline.schedule(samples.length / this.sampleRate, this.context.currentTime));
  }

  /** All pieces are in; fire when the playhead passes the end of the scheduled audio. */
  notifyWhenDrained(callback: () => void): void {
    if (this.drainTimer !== undefined) clearTimeout(this.drainTimer);
    const delayMs = this.timeline.remainingSec(this.context.currentTime) * 1_000 + 60;
    this.drainTimer = setTimeout(callback, delayMs);
  }

  stop(): void {
    if (this.drainTimer !== undefined) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already ended; nothing to stop.
      }
    }
    this.sources.clear();
    this.timeline.reset();
  }

  async close(): Promise<void> {
    this.stop();
    await this.context.close();
  }
}
