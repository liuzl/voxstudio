import type { GatewayEvent, SessionStartOptions } from "@voxstudio/realtime-gateway/protocol";
import { t } from "./i18n";
import { GatewayApiError, synthesize } from "./lib/api";
import { isMicrophonePermissionDenied, MicCapture, SpeakerOutput } from "./lib/audio";
import { GatewayClient } from "./lib/client";
import { gatewayRealtimeUrl } from "./lib/gateway-auth";
import type { BrowserLiveKitClient } from "./lib/livekit-client";
import {
  MediaTraceRecorder,
  type BrowserMediaTelemetryEvent,
  type MediaTransportFallbackReason,
} from "./lib/media-telemetry";
import { preparedLiveKitClient } from "./lib/useGatewayHealth";
import { useStudio } from "./store";

let lastMediaTracePayload: Record<string, unknown> | undefined;

const webMediaV2 = {
  version: 2,
  playback: [{ codec: "pcm_s16le", sampleRate: 24_000, channels: 1, packetDurationMs: 20 }],
} as const satisfies NonNullable<SessionStartOptions["media"]>;

/** A browser permission denial is the one start failure the user can act on. */
function microphoneStartError(error: unknown): Error {
  if (isMicrophonePermissionDenied(error)) {
    return new Error(t("麦克风权限被拒绝：请在浏览器中允许麦克风访问后重试"), { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function mayFallbackFromLiveKit(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const phase = (error as Error & { liveKitPhase?: unknown }).liveKitPhase;
  if (phase === "room connect") return true;
  if (phase !== "bootstrap") return false;
  // Authentication, validation, quota, and capacity refusals apply to the conversation,
  // not just to WebRTC. Only transport/service failures should enter compatibility mode.
  return !(error.cause instanceof GatewayApiError) || error.cause.status >= 500;
}

export function liveKitFallbackReason(error: unknown): MediaTransportFallbackReason | undefined {
  if (!mayFallbackFromLiveKit(error)) return undefined;
  return (error as Error & { liveKitPhase?: unknown }).liveKitPhase === "room connect"
    ? "livekit_room_connection_failed"
    : "livekit_service_unavailable";
}

function downloadTracePayload(payload: Record<string, unknown>): void {
  const json = JSON.stringify(payload, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `voxstudio-media-trace-${useStudio.getState().sessionId ?? "session"}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * One live conversation: microphone, gateway socket, and speaker, bound to the store.
 * Created on the user's start gesture (browser audio requires one) and torn down on stop.
 */
export class ConversationController {
  private client: Pick<GatewayClient, "sendText" | "interruptTurn" | "playbackComplete" | "requestSnapshot" | "stopSession" | "close"> | BrowserLiveKitClient | undefined;
  private livekit: BrowserLiveKitClient | undefined;
  private mic: MicCapture | undefined;
  private speaker: SpeakerOutput | undefined;
  private playbackTurnId: string | undefined;
  private lastLevelAt = 0;
  private stopped = false;
  private agentPreview = false;
  private muteOperation = 0;
  private readonly mediaTrace = new MediaTraceRecorder();
  private mediaUiTimer: ReturnType<typeof setTimeout> | undefined;

  async start(overrides?: SessionStartOptions, inputDeviceId = ""): Promise<void> {
    const store = useStudio.getState();
    this.agentPreview = overrides?.agent !== undefined;
    this.mediaTrace.reset();
    store.resetMediaDiagnostics();
    const ordinaryBehavior: SessionStartOptions = {
      // The ASR hint stays "auto": measured identical to "zh" on the SenseVoice slot
      // and remains neutral if the conversation ASR is routed elsewhere.
      language: "auto",
      ...(store.voice ? { voice: store.voice } : {}),
      ...(store.conversationAsrEngine ? { asrEngine: store.conversationAsrEngine } : {}),
      ...(store.conversationLlmEngine ? { llmEngine: store.conversationLlmEngine } : {}),
      ...(store.conversationTtsEngine ? { ttsEngine: store.conversationTtsEngine } : {}),
      turnTaking: "speculative",
      ...(store.welcome.trim() ? { welcome: store.welcome.trim() } : {}),
      ...(store.nudgeAfterSeconds > 0 ? { nudgeAfterSeconds: store.nudgeAfterSeconds } : {}),
      ...(store.studioTools ? { studioTools: true } : {}),
    };
    const webSocketStart: SessionStartOptions = overrides?.agent ? {
      // Agent preview/runtime options are a complete behavior snapshot. Only endpoint
      // capabilities are added here; local conversation prefs must not override it.
      bargeIn: true,
      playbackAck: true,
      mediaTelemetry: true,
      media: webMediaV2,
      ...overrides,
    } : {
      ...ordinaryBehavior,
      bargeIn: true,
      playbackAck: true,
      mediaTelemetry: true,
      media: webMediaV2,
    };
    const liveKitSelection: SessionStartOptions = overrides?.agent ? {
      agent: overrides.agent,
      ...(overrides.agentSource === undefined ? {} : { agentSource: overrides.agentSource }),
      ...(overrides.agentRevision === undefined ? {} : { agentRevision: overrides.agentRevision }),
      ...(overrides.agentVersion === undefined ? {} : { agentVersion: overrides.agentVersion }),
    } : ordinaryBehavior;
    let fallbackReason: MediaTransportFallbackReason | undefined;
    const LiveKitClient = preparedLiveKitClient();
    if (LiveKitClient) {
      const client = new LiveKitClient({
        selection: liveKitSelection,
        inputDeviceId,
        onEvent: event => this.handleEvent(event),
        onConnectionChange: state => useStudio.getState().setConnection(state),
        onCapabilityChange: endpoint => {
          useStudio.getState().setCapability(endpoint);
          this.recordRoute(endpoint);
        },
        onMediaTelemetry: event => this.recordBrowserMedia(event),
        onMicLevel: level => useStudio.getState().setMicLevel(level),
        onDisconnected: () => {
          if (!this.stopped) void stopConversation();
        },
      });
      this.client = client;
      this.livekit = client;
      // connect() primes iOS playback synchronously before its first await.
      try {
        await client.connect();
        if (this.stopped) throw new Error("conversation start cancelled");
        this.recordBrowserMedia({
          stage: "browser.transport",
          atMs: performance.timeOrigin + performance.now(),
          transport: "webrtc",
        });
        useStudio.getState().setActive(true);
        return;
      } catch (error) {
        this.client = undefined;
        this.livekit = undefined;
        // A microphone refusal belongs to the browser permission, not the transport.
        // Non-fallbackable failures surface it clearly; fallbackable ones continue
        // below into the WebSocket path.
        if (!mayFallbackFromLiveKit(error) || this.stopped) throw microphoneStartError(error);
        fallbackReason = liveKitFallbackReason(error);
        store.toast("info", t("WebRTC 暂时不可用，已切换到兼容模式"));
      }
    }
    this.recordBrowserMedia({
      stage: "browser.transport",
      atMs: performance.timeOrigin + performance.now(),
      transport: "websocket",
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
    });
    const client = new GatewayClient({
      url: gatewayRealtimeUrl(),
      startOptions: webSocketStart,
      onEvent: event => this.handleEvent(event),
      onAudio: (samples, delivery) => {
        this.mediaTrace.observeDelivery(samples, delivery);
        this.speaker?.enqueue(samples, delivery);
        this.scheduleMediaUi();
      },
      onConnectionChange: state => useStudio.getState().setConnection(state),
    });
    this.client = client;
    let mic: MicCapture;
    try {
      mic = await MicCapture.start(samples => {
        client.sendAudio(samples);
        this.tapLevel(samples);
      }, {
        autoRecover: true,
        deviceId: inputDeviceId,
        onCapabilityChange: capability => {
          useStudio.getState().setCapability(capability);
          this.recordRoute(capability);
        },
        onRecovered: capability => {
          useStudio.getState().toast("info", t("麦克风已恢复：{device}", {
            device: capability.deviceLabel ?? t("系统默认输入"),
          }));
        },
        onRecoveryError: error => {
          useStudio.getState().setMicLevel(0);
          useStudio.getState().toast("error", t("麦克风恢复失败：{message}", {
            message: error instanceof Error ? error.message : String(error),
          }));
        },
      });
    } catch (error) {
      throw microphoneStartError(error);
    }
    if (this.stopped) {
      await mic.stop().catch(() => {});
      throw new Error("conversation start cancelled");
    }
    this.mic = mic;
    useStudio.getState().setCapability(mic.capability());
    this.recordRoute(mic.capability());

    // Open playback only after the microphone route is stable. AirPods and other
    // Bluetooth headsets switch from A2DP playback to a duplex profile when capture
    // starts; an AudioContext created before that switch can remain bound to the stale
    // output route.
    const speaker = new SpeakerOutput(event => this.recordBrowserMedia(event));
    this.speaker = speaker;
    await speaker.resume();
    await speaker.enableContinuousPlayback();
    if (this.stopped) {
      if (this.speaker === speaker) this.speaker = undefined;
      await speaker.close().catch(() => {});
      throw new Error("conversation start cancelled");
    }
    client.connect();
    useStudio.getState().setActive(true);
  }

  async setMuted(muted: boolean): Promise<void> {
    const operation = ++this.muteOperation;
    try {
      if (this.livekit) await this.livekit.setMuted(muted);
      else this.mic?.setMuted(muted);
      if (this.stopped || operation !== this.muteOperation) return;
      useStudio.getState().setMuted(muted);
      this.recordBrowserMedia({
        stage: "browser.mute",
        atMs: performance.timeOrigin + performance.now(),
        muted,
      });
      // Muting suppresses frames at the capture node, so the meter would freeze mid-level.
      if (muted) useStudio.getState().setMicLevel(0);
    } catch (error) {
      if (this.stopped || operation !== this.muteOperation) return;
      useStudio.getState().toast("error", t("麦克风静音切换失败：{message}", {
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /**
   * Capture feedback: the meter that tells the user "the microphone hears you". Local RMS
   * only — computed from the same frames the gateway gets, throttled to the UI's pace.
   */
  private tapLevel(samples: Float32Array): void {
    const now = performance.now();
    if (now - this.lastLevelAt < 120) return;
    this.lastLevelAt = now;
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    // Speech RMS on a normalized mic sits around 0.03–0.2; map that range onto the meter.
    useStudio.getState().setMicLevel(Math.min(1, rms * 6));
  }

  /** Manual stop of the currently speaking reply — the button next to talking over it. */
  interruptPlayback(): void {
    const speaking = [...useStudio.getState().turns].reverse().find(turn => turn.status === "speaking");
    if (speaking) this.client?.interruptTurn(speaking.id);
  }

  /**
   * Submit a typed user turn through the same native session as microphone speech.
   * The gateway treats submission during an active reply as an explicit barge-in.
   */
  async submitText(text: string): Promise<boolean> {
    const submitted = text.trim();
    if (!submitted || this.client === undefined) return false;
    await this.client.sendText(submitted);
    return true;
  }

  /** The escape hatch for a stuck turn: cancel it by id (stale ids are rejected server-side). */
  cancelTurn(turnId: string): void {
    this.client?.interruptTurn(turnId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.muteOperation += 1;
    const client = this.client;
    this.client = undefined;
    await client?.stopSession();
    this.livekit = undefined;
    await this.mic?.stop();
    this.mic = undefined;
    await this.speaker?.close();
    this.speaker = undefined;
    if (this.mediaUiTimer !== undefined) clearTimeout(this.mediaUiTimer);
    this.mediaUiTimer = undefined;
    useStudio.getState().setMediaDiagnostics(this.mediaTrace.summary());
    lastMediaTracePayload = this.mediaTrace.export();
    useStudio.getState().resetSession();
  }

  downloadMediaTrace(): void {
    downloadTracePayload(this.mediaTrace.export());
  }

  private handleEvent(event: GatewayEvent): void {
    const store = useStudio.getState();
    this.mediaTrace.observeGateway(event);
    if (event.type.startsWith("media.")) this.scheduleMediaUi();
    store.apply(event);
    switch (event.type) {
      case "session.state":
        // A server-side hangup (the end_call tool) must release the microphone too —
        // an ended session with a live capture is a privacy bug, not a UI nit.
        if (event.state === "closed") void stopConversation();
        return;
      case "playback.format":
        this.playbackTurnId = event.turnId;
        this.speaker?.setFormat(event.sampleRate);
        return;
      case "playback.start":
        this.playbackTurnId = event.turnId;
        this.speaker?.beginContinuousRendition(event.sampleRate);
        return;
      case "studio.take":
        // A spoken generate_take: the event reaches the same browser whose Generate
        // panel owns takes, so the client runs the generation it would have run from
        // the button — the gateway stays out of the batch-synthesis business.
        void (async () => {
          try {
            const url = await synthesize({ input: event.text, voice: event.voice ?? store.voice ?? "" });
            store.addTake({
              id: crypto.randomUUID(),
              text: event.text,
              voice: `${event.voice ?? ""} (${t("对话")})`.trim(),
              at: Date.now(),
              url,
            });
            store.toast("info", t("对话生成的一条已加入生成面板"));
          } catch (failure) {
            store.toast("error", failure instanceof Error ? failure.message : String(failure));
          }
        })();
        return;
      case "playback.ended": {
        // The server sent the last piece; the audible clock is ours. Ack when the playhead
        // passes the end of what was scheduled.
        const turnId = event.turnId;
        this.speaker?.notifyWhenDrained(() => {
          if (this.playbackTurnId === turnId) this.client?.playbackComplete(turnId);
        });
        return;
      }
      case "playback.interrupted":
      case "turn.interrupted":
        this.speaker?.stop("interrupted");
        return;
      case "command.rejected":
        // ConversationPanel renders notices inline; Agent Builder does not, so a native
        // admission refusal also needs a visible toast on either preview transport.
        if (this.agentPreview) store.toast("error", `${t("失败")}: ${event.reason}`);
        return;
      default:
        return;
    }
  }

  private recordBrowserMedia(event: BrowserMediaTelemetryEvent): void {
    this.mediaTrace.observeBrowser(event);
    this.scheduleMediaUi();
  }

  private recordRoute(capability: ReturnType<MicCapture["capability"]>): void {
    this.recordBrowserMedia({
      stage: "browser.route",
      atMs: performance.timeOrigin + performance.now(),
      ...(capability.deviceId === undefined ? {} : { deviceId: capability.deviceId }),
      ...(capability.deviceLabel === undefined ? {} : { label: capability.deviceLabel }),
      ...(capability.trackState === undefined ? {} : { trackState: capability.trackState }),
      recoveries: capability.recoveries,
    });
  }

  private scheduleMediaUi(): void {
    if (this.mediaUiTimer !== undefined) return;
    this.mediaUiTimer = setTimeout(() => {
      this.mediaUiTimer = undefined;
      useStudio.getState().setMediaDiagnostics(this.mediaTrace.summary());
    }, 200);
  }
}

/**
 * The one live conversation, app-scoped: it belongs to the session, not to the panel that
 * happens to be showing it. Switching tabs unmounts the panel; the conversation keeps
 * running and the sidebar keeps showing its connection state.
 */
let current: ConversationController | undefined;

export async function startConversation(options?: SessionStartOptions, inputDeviceId?: string): Promise<void> {
  if (current) throw new Error("conversation is already starting or active");
  const next = new ConversationController();
  current = next;
  try {
    await next.start(options, inputDeviceId ?? useStudio.getState().micInputDeviceId);
  } catch (error) {
    // A cancelled start may finish after another caller has begun a replacement;
    // never let the stale controller clear ownership of that newer conversation.
    if (current === next) current = undefined;
    await next.stop().catch(() => {});
    throw error;
  }
}

export async function stopConversation(): Promise<void> {
  const active = current;
  current = undefined;
  await active?.stop();
}

export function conversationControls(): Pick<ConversationController, "setMuted" | "submitText" | "interruptPlayback" | "cancelTurn" | "downloadMediaTrace"> | undefined {
  return current;
}

export function downloadMediaTrace(): void {
  if (current) current.downloadMediaTrace();
  else if (lastMediaTracePayload) downloadTracePayload(lastMediaTracePayload);
}
