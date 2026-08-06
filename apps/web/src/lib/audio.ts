/** The negotiated capture route, reported to the session per the duplex doc. */
export interface EndpointCapability {
  echoCancellation: boolean | undefined;
  noiseSuppression: boolean | undefined;
  autoGainControl: boolean | undefined;
  deviceId: string | undefined;
  deviceLabel: string | undefined;
  trackMuted: boolean;
  trackState: MediaStreamTrackState | undefined;
  trackSampleRate: number | undefined;
  contextSampleRate: number;
  recoveries: number;
}

// The streaming resampler now lives in @voxstudio/audio (the realtime gateway's OpenAI
// adapter shares it); re-exported so this module remains the web audio toolbox.
import { LinearResampler } from "@voxstudio/audio";

export { LinearResampler };

import type { AudioFrameDelivery } from "./client";
import type { BrowserMediaTelemetryEvent } from "./media-telemetry";

export interface PlaybackSchedule {
  startAtSec: number;
  bufferBeforeSec: number;
  bufferAfterSec: number;
  underrunSec: number;
}

/**
 * Schedule math for gapless streamed playback: each chunk starts where the previous one
 * ends (or now plus a small lead when the queue ran dry), and the audible end is always
 * `remainingSec` away. Pure so the clock behavior is testable without an AudioContext.
 */
export class PlaybackTimeline {
  private readonly leadSec: number;
  private readonly rebufferSec: number;
  private playheadSec = 0;

  // The initial lead must cover the delivery interval of the slowest streaming
  // engine: the C++ VoxCPM2 server sends two small fast-start chunks (~0.16s
  // each) and then ~0.64s batches, so a 50ms lead started playback eagerly and
  // starved right at the top of every reply — heard as stutter at the start.
  // 0.45s waits for the fast-start chunks plus most of the first batch before
  // the first sample plays; fast engines simply start ~0.4s later than before.
  // 0.7s: at the start of a reply the LLM is still generating its remaining
  // sentences on the same GPU, so TTS chunk supply runs near 1:1 with playback
  // until the LLM finishes; the larger initial cushion absorbs that window.
  constructor(leadSec = 0.7, rebufferSec = 0.7) {
    this.leadSec = leadSec;
    this.rebufferSec = rebufferSec;
  }

  get targetBufferSec(): number {
    return this.rebufferSec;
  }

  schedule(durationSec: number, nowSec: number): number {
    return this.scheduleWithMetrics(durationSec, nowSec).startAtSec;
  }

  scheduleWithMetrics(durationSec: number, nowSec: number): PlaybackSchedule {
    // An underrun (the queue drained mid-reply) re-buffers instead of resuming at once:
    // bursty delivery would otherwise play as burst-gap-burst — a string of micro-gaps
    // that shreds words into crackle. One audible pause, then contiguous speech; the
    // cushion also absorbs the next delivery wobble. A fresh reply keeps the low lead.
    const starved = this.playheadSec > 0 && this.playheadSec < nowSec;
    const bufferBeforeSec = Math.max(0, this.playheadSec - nowSec);
    const underrunSec = starved ? nowSec - this.playheadSec : 0;
    const startAt = Math.max(nowSec + (starved ? this.rebufferSec : this.leadSec), this.playheadSec);
    this.playheadSec = startAt + durationSec;
    return {
      startAtSec: startAt,
      bufferBeforeSec,
      bufferAfterSec: Math.max(0, this.playheadSec - nowSec),
      underrunSec,
    };
  }

  remainingSec(nowSec: number): number {
    return Math.max(0, this.playheadSec - nowSec);
  }

  reset(): void {
    this.playheadSec = 0;
  }

  /** A normally completed rendition is a boundary, not an underrun before the next one. */
  completeRendition(): void {
    this.reset();
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

export const playbackWorkletSource = `
class VoxPlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.queuedSamples = 0;
    this.playing = false;
    this.ended = false;
    this.drained = false;
    this.underrunFrame = undefined;
    this.stableSamples = 0;
    this.minimumTarget = Math.round(sampleRate * 0.12);
    this.targetSamples = Math.round(sampleRate * 0.16);
    this.maximumTarget = Math.round(sampleRate * 0.6);
    this.port.onmessage = event => this.receive(event.data);
  }

  receive(message) {
    if (message.type === "start") {
      this.queue = [];
      this.queuedSamples = 0;
      this.playing = false;
      this.ended = false;
      this.drained = false;
      this.underrunFrame = undefined;
      this.stableSamples = 0;
      return;
    }
    if (message.type === "enqueue") {
      const samples = message.samples;
      if (!(samples instanceof Float32Array) || samples.length === 0 || this.ended) return;
      this.queue.push({ samples, offset: 0, frameId: message.frameId });
      this.queuedSamples += samples.length;
      return;
    }
    if (message.type === "end") {
      this.ended = true;
      this.reportDrainedIfReady();
      return;
    }
    if (message.type === "stop") {
      this.queue = [];
      this.queuedSamples = 0;
      this.playing = false;
      this.ended = false;
      this.drained = false;
      this.underrunFrame = undefined;
      this.stableSamples = 0;
    }
  }

  reportDrainedIfReady() {
    if (!this.ended || this.queuedSamples !== 0 || this.drained) return;
    this.drained = true;
    this.playing = false;
    this.port.postMessage({ type: "drained", contextTimeSec: currentTime });
  }

  process(_inputs, outputs) {
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    output.fill(0);
    if (!this.playing) {
      if (this.queuedSamples >= this.targetSamples || (this.ended && this.queuedSamples > 0)) {
        this.playing = true;
        if (this.underrunFrame !== undefined) {
          const durationSamples = Math.max(0, currentFrame - this.underrunFrame);
          this.port.postMessage({ type: "underrun", durationSamples, targetSamples: this.targetSamples });
          this.underrunFrame = undefined;
        }
      } else {
        this.reportDrainedIfReady();
        return true;
      }
    }

    let written = 0;
    while (written < output.length) {
      const item = this.queue[0];
      if (!item) {
        if (!this.ended) {
          this.playing = false;
          this.underrunFrame = currentFrame + written;
          this.stableSamples = 0;
          this.targetSamples = Math.min(this.maximumTarget, this.targetSamples + Math.round(sampleRate * 0.04));
        }
        break;
      }
      if (item.offset === 0) {
        this.port.postMessage({
          type: "render",
          frameId: item.frameId,
          contextTimeSec: currentTime + written / sampleRate,
          bufferSamples: this.queuedSamples,
          targetSamples: this.targetSamples,
        });
      }
      const available = item.samples.length - item.offset;
      const count = Math.min(available, output.length - written);
      output.set(item.samples.subarray(item.offset, item.offset + count), written);
      item.offset += count;
      written += count;
      this.queuedSamples -= count;
      if (item.offset === item.samples.length) this.queue.shift();
    }

    if (written > 0) {
      this.stableSamples += written;
      if (this.stableSamples >= sampleRate * 10 && this.targetSamples > this.minimumTarget) {
        this.targetSamples = Math.max(this.minimumTarget, this.targetSamples - Math.round(sampleRate * 0.02));
        this.stableSamples = 0;
      }
    }
    this.reportDrainedIfReady();
    return true;
  }
}
registerProcessor("vox-playback", VoxPlayback);
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
  /** Explicit origin-scoped MediaDeviceInfo id. Empty follows Chrome's site default. */
  deviceId?: string;
  /** Follow the OS default input across headset/profile changes. Conversation enables
   * this; reference recording stays pinned so one sample cannot mix microphones. */
  autoRecover?: boolean;
  onCapabilityChange?(capability: EndpointCapability): void;
  onRecovered?(capability: EndpointCapability, reason: string): void;
  onRecoveryError?(error: unknown): void;
}

export function microphoneConstraints(processing = true, deviceId = ""): MediaTrackConstraints {
  return {
    echoCancellation: processing,
    noiseSuppression: processing,
    autoGainControl: processing,
    channelCount: 1,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

export interface AudioInputDevice {
  id: string;
  label: string;
}

/** Enumerate origin-visible microphones. Labels become available after the first grant. */
export async function listAudioInputDevices(): Promise<AudioInputDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  let unnamed = 0;
  return devices
    // Pre-permission Chrome reports one placeholder with an empty deviceId and label;
    // it is not a usable input, so it must never appear as "Microphone 1".
    .filter(device => device.kind === "audioinput" && device.deviceId !== "" && device.deviceId !== "default")
    .map(device => ({
      id: device.deviceId,
      label: device.label || `Microphone ${++unnamed}`,
    }));
}

/**
 * Request microphone access so device labels become visible. Call from a user
 * gesture; resolves without prompting when permission was already granted.
 */
export async function grantMicrophonePermission(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach(track => track.stop());
}

/** True when a capture/start failure is a microphone permission denial. */
export function isMicrophonePermissionDenied(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "NotAllowedError" || error.name === "PermissionDeniedError";
  }
  return error instanceof Error && /permission|denied|notallowed|not allowed/i.test(error.message);
}

export class MicCapture {
  private readonly context: AudioContext;
  private stream: MediaStream;
  private source: MediaStreamAudioSourceNode;
  private node: AudioWorkletNode;
  private resampler: LinearResampler;
  private readonly onFrame: (samples: Float32Array) => void;
  private readonly options: MicCaptureOptions;
  private buffered: Float32Array = new Float32Array(0);
  private muted = false;
  private stopped = false;
  private recoveries = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryReason = "device change";
  private recoveryPromise: Promise<void> | undefined;
  private recoverAgain = false;
  private routeWatchdog: ReturnType<typeof setTimeout> | undefined;
  private consecutiveFrameFailures = 0;

  private constructor(
    context: AudioContext,
    stream: MediaStream,
    source: MediaStreamAudioSourceNode,
    node: AudioWorkletNode,
    onFrame: (samples: Float32Array) => void,
    options: MicCaptureOptions,
  ) {
    this.context = context;
    this.stream = stream;
    this.source = source;
    this.node = node;
    this.onFrame = onFrame;
    this.options = options;
    this.resampler = new LinearResampler(context.sampleRate, targetRate);
    this.attachRoute(node, stream);
    this.armRouteWatchdog(node);
    if (options.autoRecover && typeof navigator.mediaDevices.addEventListener === "function") {
      navigator.mediaDevices.addEventListener("devicechange", this.handleDeviceChange);
    }
  }

  static async start(onFrame: (samples: Float32Array) => void, options: MicCaptureOptions = {}): Promise<MicCapture> {
    const processing = options.processing ?? true;
    // Acquire the default route before playback opens. On macOS this lets a Bluetooth
    // headset finish its A2DP -> duplex profile transition before SpeakerOutput captures
    // the output device and sample rate.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: microphoneConstraints(processing, options.deviceId),
    });
    let context: AudioContext | undefined;
    try {
      context = new AudioContext({ sampleRate: targetRate });
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
      return new MicCapture(context, stream, source, node, onFrame, options);
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      await context?.close().catch(() => {});
      throw error;
    }
  }

  /** The negotiated constraints snapshot the duplex doc requires the endpoint to report. */
  capability(): EndpointCapability {
    const track = this.stream.getAudioTracks()[0];
    const settings = track?.getSettings() ?? {};
    return {
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
      deviceId: settings.deviceId,
      deviceLabel: track?.label || undefined,
      trackMuted: track?.muted ?? false,
      trackState: track?.readyState,
      trackSampleRate: settings.sampleRate,
      contextSampleRate: this.context.sampleRate,
      recoveries: this.recoveries,
    };
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.stream.getAudioTracks()) track.enabled = !muted;
    if (muted && this.routeWatchdog !== undefined) {
      clearTimeout(this.routeWatchdog);
      this.routeWatchdog = undefined;
    } else if (!muted) {
      this.armRouteWatchdog(this.node);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (typeof navigator.mediaDevices.removeEventListener === "function") {
      navigator.mediaDevices.removeEventListener("devicechange", this.handleDeviceChange);
    }
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
    if (this.routeWatchdog !== undefined) clearTimeout(this.routeWatchdog);
    this.node.port.onmessage = null;
    this.node.disconnect();
    this.source.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    await this.recoveryPromise?.catch(() => {});
    await this.context.close();
  }

  private readonly handleDeviceChange = (): void => {
    this.queueRecovery("audio device changed", 350);
  };

  private attachRoute(node: AudioWorkletNode, stream: MediaStream): void {
    node.port.onmessage = event => {
      if (this.stopped || this.node !== node) return;
      if (this.routeWatchdog !== undefined) {
        clearTimeout(this.routeWatchdog);
        this.routeWatchdog = undefined;
      }
      this.consecutiveFrameFailures = 0;
      if (this.muted) return;
      const resampled = this.resampler.push(event.data as Float32Array);
      if (resampled.length === 0) return;
      const joined = new Float32Array(this.buffered.length + resampled.length);
      joined.set(this.buffered);
      joined.set(resampled, this.buffered.length);
      let offset = 0;
      while (joined.length - offset >= frameSamples) {
        this.onFrame(joined.slice(offset, offset + frameSamples));
        offset += frameSamples;
      }
      this.buffered = joined.slice(offset);
    };
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    track.addEventListener("mute", () => {
      if (this.currentTrack() !== track || this.stopped) return;
      this.emitCapability();
      // Bluetooth profile changes mute briefly. Only rebuild when it does not recover on
      // its own, otherwise every harmless radio hiccup would churn the input stream.
      this.queueRecovery("microphone stayed muted", 800);
    });
    track.addEventListener("unmute", () => {
      if (this.currentTrack() !== track || this.stopped) return;
      if (this.recoveryTimer !== undefined && this.recoveryReason === "microphone stayed muted") {
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = undefined;
      }
      this.emitCapability();
    });
    track.addEventListener("ended", () => {
      if (this.currentTrack() !== track || this.stopped) return;
      this.emitCapability();
      this.queueRecovery("microphone track ended", 0);
    });
  }

  private currentTrack(): MediaStreamTrack | undefined {
    return this.stream.getAudioTracks()[0];
  }

  private emitCapability(): void {
    this.options.onCapabilityChange?.(this.capability());
  }

  private armRouteWatchdog(node: AudioWorkletNode): void {
    if (!this.options.autoRecover || this.muted) return;
    if (this.routeWatchdog !== undefined) clearTimeout(this.routeWatchdog);
    this.routeWatchdog = setTimeout(() => {
      this.routeWatchdog = undefined;
      if (this.stopped || this.node !== node) return;
      this.consecutiveFrameFailures += 1;
      if (this.consecutiveFrameFailures <= 3) {
        this.queueRecovery("microphone produced no audio frames", 0);
      } else {
        this.options.onRecoveryError?.(new Error("microphone route is live but produced no audio frames"));
      }
    }, 2_000);
  }

  private queueRecovery(reason: string, delayMs: number): void {
    if (this.stopped || !this.options.autoRecover) return;
    this.recoveryReason = reason;
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.recover(reason);
    }, delayMs);
  }

  private async recover(reason: string): Promise<void> {
    if (this.stopped) return;
    if (this.recoveryPromise !== undefined) {
      this.recoverAgain = true;
      return this.recoveryPromise;
    }
    const run = async (): Promise<void> => {
      do {
        this.recoverAgain = false;
        const processing = this.options.processing ?? true;
        const replacement = await navigator.mediaDevices.getUserMedia({
          audio: microphoneConstraints(processing, this.options.deviceId),
        });
        if (this.stopped) {
          for (const track of replacement.getTracks()) track.stop();
          return;
        }
        let source: MediaStreamAudioSourceNode | undefined;
        let node: AudioWorkletNode | undefined;
        try {
          source = this.context.createMediaStreamSource(replacement);
          node = new AudioWorkletNode(this.context, "vox-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
          source.connect(node);
        } catch (error) {
          for (const track of replacement.getTracks()) track.stop();
          throw error;
        }

        const previousStream = this.stream;
        const previousSource = this.source;
        const previousNode = this.node;
        previousNode.port.onmessage = null;
        this.stream = replacement;
        this.source = source;
        this.node = node;
        this.resampler = new LinearResampler(this.context.sampleRate, targetRate);
        this.buffered = new Float32Array(0);
        this.recoveries += 1;
        for (const track of replacement.getAudioTracks()) track.enabled = !this.muted;
        this.attachRoute(node, replacement);
        this.armRouteWatchdog(node);
        previousNode.disconnect();
        previousSource.disconnect();
        for (const track of previousStream.getTracks()) track.stop();
        const capability = this.capability();
        this.options.onCapabilityChange?.(capability);
        this.options.onRecovered?.(capability, reason);
      } while (this.recoverAgain && !this.stopped);
    };
    this.recoveryPromise = run();
    try {
      await this.recoveryPromise;
    } catch (error) {
      this.options.onRecoveryError?.(error);
    } finally {
      this.recoveryPromise = undefined;
    }
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
  private playbackNode: AudioWorkletNode | undefined;
  private playbackResampler: LinearResampler | undefined;
  private continuousInputRate: number | undefined;
  private continuousBufferedSamples = 0;
  private continuousTargetSamples = 0;
  private continuousDrainCallback: (() => void) | undefined;
  private continuousActive = false;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly renderTimers = new Map<AudioBufferSourceNode, ReturnType<typeof setTimeout>>();
  private readonly onTelemetry: ((event: BrowserMediaTelemetryEvent) => void) | undefined;

  constructor(onTelemetry?: (event: BrowserMediaTelemetryEvent) => void) {
    this.context = new AudioContext();
    this.onTelemetry = onTelemetry;
    this.context.addEventListener("statechange", this.reportContext);
    this.reportContext();
  }

  async resume(): Promise<void> {
    await this.context.resume();
    this.reportContext();
  }

  /** Prepare the single render-thread-owned Media v2 output before negotiation. */
  async enableContinuousPlayback(): Promise<void> {
    if (this.playbackNode !== undefined) return;
    const workletUrl = URL.createObjectURL(new Blob([playbackWorkletSource], { type: "text/javascript" }));
    try {
      await this.context.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    const node = new AudioWorkletNode(this.context, "vox-playback", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.port.onmessage = event => this.handlePlaybackWorkletMessage(event.data as Record<string, unknown>);
    node.connect(this.context.destination);
    this.playbackNode = node;
  }

  setFormat(sampleRate: number): void {
    this.sampleRate = sampleRate;
  }

  beginContinuousRendition(sampleRate: number): void {
    if (this.playbackNode === undefined) throw new Error("continuous playback was not initialized");
    this.sampleRate = sampleRate;
    this.continuousInputRate = sampleRate;
    this.playbackResampler = new LinearResampler(sampleRate, this.context.sampleRate);
    this.continuousBufferedSamples = 0;
    this.continuousDrainCallback = undefined;
    this.continuousActive = true;
    this.playbackNode.port.postMessage({ type: "start" });
  }

  enqueue(samples: Float32Array, delivery?: AudioFrameDelivery): void {
    if (samples.length === 0) return;
    if (delivery?.media !== undefined && this.playbackNode !== undefined && this.continuousActive) {
      this.enqueueContinuous(samples, delivery);
      return;
    }
    const buffer = this.context.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => {
      this.sources.delete(source);
      const timer = this.renderTimers.get(source);
      if (timer !== undefined) clearTimeout(timer);
      this.renderTimers.delete(source);
    };
    this.sources.add(source);
    const nowSec = this.context.currentTime;
    const schedule = this.timeline.scheduleWithMetrics(samples.length / this.sampleRate, nowSec);
    const atMs = performance.timeOrigin + performance.now();
    const frameId = delivery?.frame?.frameId;
    if (schedule.underrunSec > 0) {
      this.onTelemetry?.({
        stage: "browser.underrun",
        atMs,
        ...(frameId === undefined ? {} : { frameId }),
        durationMs: schedule.underrunSec * 1_000,
      });
    }
    this.onTelemetry?.({
      stage: "browser.enqueue",
      atMs,
      ...(frameId === undefined ? {} : { frameId }),
      bufferBeforeMs: schedule.bufferBeforeSec * 1_000,
      bufferAfterMs: schedule.bufferAfterSec * 1_000,
      targetBufferMs: this.timeline.targetBufferSec * 1_000,
    });
    const scheduledAtMs = atMs + Math.max(0, schedule.startAtSec - nowSec) * 1_000;
    const renderTimer = setTimeout(() => {
      this.renderTimers.delete(source);
      const renderedAtMs = performance.timeOrigin + performance.now();
      this.onTelemetry?.({
        stage: "browser.render",
        atMs: renderedAtMs,
        ...(frameId === undefined ? {} : { frameId }),
        scheduledAtMs,
        latenessMs: Math.max(0, renderedAtMs - scheduledAtMs),
        bufferDepthMs: this.timeline.remainingSec(this.context.currentTime) * 1_000,
        estimated: true,
      });
    }, Math.max(0, scheduledAtMs - (performance.timeOrigin + performance.now())));
    this.renderTimers.set(source, renderTimer);
    source.start(schedule.startAtSec);
  }

  /** All pieces are in; fire when the playhead passes the end of the scheduled audio. */
  notifyWhenDrained(callback: () => void): void {
    if (this.continuousActive && this.playbackNode !== undefined) {
      this.continuousDrainCallback = callback;
      this.playbackNode.port.postMessage({ type: "end" });
      return;
    }
    if (this.drainTimer !== undefined) clearTimeout(this.drainTimer);
    const delayMs = this.timeline.remainingSec(this.context.currentTime) * 1_000 + 60;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.timeline.completeRendition();
      callback();
    }, delayMs);
  }

  stop(reason: "interrupted" | "closed" = "closed"): void {
    const startedAtMs = performance.timeOrigin + performance.now();
    const sourceCount = this.sources.size + (this.continuousActive && this.continuousBufferedSamples > 0 ? 1 : 0);
    if (this.drainTimer !== undefined) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    for (const source of this.sources) {
      const timer = this.renderTimers.get(source);
      if (timer !== undefined) clearTimeout(timer);
      try {
        source.stop();
      } catch {
        // Already ended; nothing to stop.
      }
    }
    this.sources.clear();
    this.renderTimers.clear();
    this.timeline.reset();
    if (this.playbackNode !== undefined) this.playbackNode.port.postMessage({ type: "stop" });
    this.playbackResampler = undefined;
    this.continuousInputRate = undefined;
    this.continuousBufferedSamples = 0;
    this.continuousDrainCallback = undefined;
    this.continuousActive = false;
    const finishedAtMs = performance.timeOrigin + performance.now();
    if (sourceCount > 0) {
      this.onTelemetry?.({
        stage: "browser.stop",
        atMs: finishedAtMs,
        reason,
        sourceCount,
        operationMs: Math.max(0, finishedAtMs - startedAtMs),
      });
    }
  }

  async close(): Promise<void> {
    this.stop("closed");
    if (this.playbackNode !== undefined) {
      this.playbackNode.port.onmessage = null;
      this.playbackNode.disconnect();
      this.playbackNode = undefined;
    }
    this.context.removeEventListener("statechange", this.reportContext);
    await this.context.close();
  }

  private enqueueContinuous(samples: Float32Array, delivery: AudioFrameDelivery): void {
    if (this.playbackNode === undefined || this.playbackResampler === undefined
        || this.continuousInputRate !== this.sampleRate) {
      throw new Error("Media v2 audio arrived outside its playback rendition");
    }
    const resampled = this.playbackResampler.push(samples);
    if (resampled.length === 0) return;
    const before = this.continuousBufferedSamples;
    this.continuousBufferedSamples += resampled.length;
    const atMs = performance.timeOrigin + performance.now();
    const frameId = delivery.frame?.frameId;
    this.onTelemetry?.({
      stage: "browser.enqueue",
      atMs,
      ...(frameId === undefined ? {} : { frameId }),
      bufferBeforeMs: before * 1_000 / this.context.sampleRate,
      bufferAfterMs: this.continuousBufferedSamples * 1_000 / this.context.sampleRate,
      targetBufferMs: (this.continuousTargetSamples || this.context.sampleRate * 0.16) * 1_000 / this.context.sampleRate,
    });
    const transferable = resampled.slice();
    this.playbackNode.port.postMessage(
      { type: "enqueue", samples: transferable, frameId },
      [transferable.buffer],
    );
  }

  private handlePlaybackWorkletMessage(message: Record<string, unknown>): void {
    if (!this.continuousActive || typeof message.type !== "string") return;
    const contextTimeSec = typeof message.contextTimeSec === "number" ? message.contextTimeSec : this.context.currentTime;
    const atMs = this.contextTimeToEpoch(contextTimeSec);
    if (message.type === "render") {
      const bufferSamples = typeof message.bufferSamples === "number" ? message.bufferSamples : 0;
      const targetSamples = typeof message.targetSamples === "number" ? message.targetSamples : 0;
      this.continuousBufferedSamples = Math.max(0, bufferSamples);
      this.continuousTargetSamples = Math.max(0, targetSamples);
      const frameId = typeof message.frameId === "number" ? message.frameId : undefined;
      this.onTelemetry?.({
        stage: "browser.render",
        atMs,
        ...(frameId === undefined ? {} : { frameId }),
        scheduledAtMs: atMs,
        latenessMs: 0,
        bufferDepthMs: this.continuousBufferedSamples * 1_000 / this.context.sampleRate,
        estimated: false,
      });
      return;
    }
    if (message.type === "underrun") {
      const durationSamples = typeof message.durationSamples === "number" ? message.durationSamples : 0;
      const targetSamples = typeof message.targetSamples === "number" ? message.targetSamples : 0;
      this.continuousTargetSamples = Math.max(0, targetSamples);
      if (durationSamples > 0) {
        this.onTelemetry?.({
          stage: "browser.underrun",
          atMs,
          durationMs: durationSamples * 1_000 / this.context.sampleRate,
        });
      }
      return;
    }
    if (message.type === "drained") {
      this.continuousBufferedSamples = 0;
      this.continuousActive = false;
      const callback = this.continuousDrainCallback;
      this.continuousDrainCallback = undefined;
      callback?.();
    }
  }

  private contextTimeToEpoch(contextTimeSec: number): number {
    const nowMs = performance.timeOrigin + performance.now();
    return nowMs + (contextTimeSec - this.context.currentTime) * 1_000;
  }

  private readonly reportContext = (): void => {
    const outputLatencyMs = "outputLatency" in this.context
      ? Number((this.context as AudioContext & { outputLatency: number }).outputLatency) * 1_000
      : undefined;
    this.onTelemetry?.({
      stage: "browser.context",
      atMs: performance.timeOrigin + performance.now(),
      state: this.context.state,
      sampleRate: this.context.sampleRate,
      ...(outputLatencyMs === undefined || !Number.isFinite(outputLatencyMs) ? {} : { outputLatencyMs }),
    });
  };
}
