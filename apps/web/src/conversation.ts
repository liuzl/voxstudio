import type { GatewayEvent } from "@voxstudio/realtime-gateway/protocol";
import { MicCapture, SpeakerOutput } from "./lib/audio";
import { GatewayClient } from "./lib/client";
import { useStudio } from "./store";

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

  async start(): Promise<void> {
    const store = useStudio.getState();
    const speaker = new SpeakerOutput();
    await speaker.resume();
    this.speaker = speaker;
    const client = new GatewayClient({
      url: realtimeUrl(),
      startOptions: {
        language: store.language,
        ...(store.voice ? { voice: store.voice } : {}),
        ...(store.voiceEngine ? { ttsEngine: store.voiceEngine } : {}),
        // The browser endpoint negotiates AEC in getUserMedia, so barge-in is on and the
        // endpoint owns the audible-playback clock.
        bargeIn: true,
        playbackAck: true,
        turnTaking: "speculative",
      },
      onEvent: event => this.handleEvent(event),
      onAudio: samples => this.speaker?.enqueue(samples),
      onConnectionChange: state => useStudio.getState().setConnection(state),
    });
    this.client = client;
    const mic = await MicCapture.start(samples => {
      client.sendAudio(samples);
      this.tapLevel(samples);
    });
    this.mic = mic;
    useStudio.getState().setCapability(mic.capability());
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

  async stop(): Promise<void> {
    this.client?.stopSession();
    this.client = undefined;
    await this.mic?.stop();
    this.mic = undefined;
    await this.speaker?.close();
    this.speaker = undefined;
    useStudio.getState().resetSession();
  }

  private handleEvent(event: GatewayEvent): void {
    const store = useStudio.getState();
    store.apply(event);
    switch (event.type) {
      case "playback.format":
        this.playbackTurnId = event.turnId;
        this.speaker?.setFormat(event.sampleRate);
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
        this.speaker?.stop();
        return;
      default:
        return;
    }
  }
}

function realtimeUrl(): string {
  const base = new URL("/v1/realtime", window.location.href);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return base.toString();
}

/**
 * The one live conversation, app-scoped: it belongs to the session, not to the panel that
 * happens to be showing it. Switching tabs unmounts the panel; the conversation keeps
 * running and the sidebar keeps showing its connection state.
 */
let current: ConversationController | undefined;

export async function startConversation(): Promise<void> {
  if (current) return;
  const next = new ConversationController();
  current = next;
  try {
    await next.start();
  } catch (error) {
    current = undefined;
    await next.stop().catch(() => {});
    throw error;
  }
}

export async function stopConversation(): Promise<void> {
  const active = current;
  current = undefined;
  await active?.stop();
}

export function conversationControls(): Pick<ConversationController, "setMuted" | "interruptPlayback"> | undefined {
  return current;
}
