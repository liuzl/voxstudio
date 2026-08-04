import type { GatewayEvent, SessionStartOptions } from "@voxstudio/realtime-gateway/protocol";
import { t } from "./i18n";
import { synthesize } from "./lib/api";
import { MicCapture, SpeakerOutput } from "./lib/audio";
import { GatewayClient } from "./lib/client";
import { gatewayRealtimeUrl } from "./lib/gateway-auth";
import { MediaTraceRecorder, type BrowserMediaTelemetryEvent } from "./lib/media-telemetry";
import { useStudio } from "./store";

let lastMediaTracePayload: Record<string, unknown> | undefined;

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
  private client: GatewayClient | undefined;
  private mic: MicCapture | undefined;
  private speaker: SpeakerOutput | undefined;
  private playbackTurnId: string | undefined;
  private lastLevelAt = 0;
  private stopped = false;
  private readonly mediaTrace = new MediaTraceRecorder();
  private mediaUiTimer: ReturnType<typeof setTimeout> | undefined;

  async start(overrides?: SessionStartOptions, inputDeviceId = ""): Promise<void> {
    const store = useStudio.getState();
    this.mediaTrace.reset();
    store.resetMediaDiagnostics();
    const client = new GatewayClient({
      url: gatewayRealtimeUrl(),
      startOptions: overrides?.agent ? {
        // Agent preview/runtime options are already a complete behavior snapshot on the
        // gateway. Only endpoint capabilities belong here; local conversation prefs must
        // not silently override the saved Agent's voice, prompt, or greeting.
        bargeIn: true,
        playbackAck: true,
        mediaTelemetry: true,
        ...overrides,
      } : {
        // The ASR hint stays "auto": measured identical to "zh" on the SenseVoice slot
        // (2026-07-17, pure-zh / code-switched / pure-en all byte-equal), and neutral if
        // the conversation ASR is ever routed to an engine that does care.
        language: "auto",
        ...(store.voice ? { voice: store.voice } : {}),
        ...(store.conversationAsrEngine ? { asrEngine: store.conversationAsrEngine } : {}),
        ...(store.conversationLlmEngine ? { llmEngine: store.conversationLlmEngine } : {}),
        ...(store.conversationTtsEngine ? { ttsEngine: store.conversationTtsEngine } : {}),
        // The browser endpoint negotiates AEC in getUserMedia, so barge-in is on and the
        // endpoint owns the audible-playback clock.
        bargeIn: true,
        playbackAck: true,
        mediaTelemetry: true,
        turnTaking: "speculative",
        ...(store.welcome.trim() ? { welcome: store.welcome.trim() } : {}),
        ...(store.nudgeAfterSeconds > 0 ? { nudgeAfterSeconds: store.nudgeAfterSeconds } : {}),
        ...(store.studioTools ? { studioTools: true } : {}),
      },
      onEvent: event => this.handleEvent(event),
      onAudio: (samples, delivery) => {
        this.mediaTrace.observeDelivery(samples, delivery);
        this.speaker?.enqueue(samples, delivery);
        this.scheduleMediaUi();
      },
      onConnectionChange: state => useStudio.getState().setConnection(state),
    });
    this.client = client;
    const mic = await MicCapture.start(samples => {
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
    if (this.stopped) {
      if (this.speaker === speaker) this.speaker = undefined;
      await speaker.close().catch(() => {});
      throw new Error("conversation start cancelled");
    }
    client.connect();
    useStudio.getState().setActive(true);
  }

  setMuted(muted: boolean): void {
    this.mic?.setMuted(muted);
    useStudio.getState().setMuted(muted);
    // Muting suppresses frames at the capture node, so the meter would freeze mid-level.
    if (muted) useStudio.getState().setMicLevel(0);
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

  /** The escape hatch for a stuck turn: cancel it by id (stale ids are rejected server-side). */
  cancelTurn(turnId: string): void {
    this.client?.interruptTurn(turnId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.client?.stopSession();
    this.client = undefined;
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

export function conversationControls(): Pick<ConversationController, "setMuted" | "interruptPlayback" | "cancelTurn" | "downloadMediaTrace"> | undefined {
  return current;
}

export function downloadMediaTrace(): void {
  if (current) current.downloadMediaTrace();
  else if (lastMediaTracePayload) downloadTracePayload(lastMediaTracePayload);
}
