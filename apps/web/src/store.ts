import type { GatewayEvent } from "@voxstudio/realtime-gateway/protocol";
import type { VoiceEntry } from "./lib/api";
import { create } from "zustand";
import type { EndpointCapability } from "./lib/audio";
import type { ConnectionState } from "./lib/client";

export interface TurnView {
  id: string;
  /** Client clock when the turn opened — the caption row's timestamp. */
  at: number;
  revision: number;
  transcript: string | undefined;
  reply: string;
  status: "capturing" | "thinking" | "speaking" | "completed" | "interrupted";
  /** Client clock at the last status change — drives the "已等待 Ns" escape hatch. */
  statusAt: number;
  reopens: number;
  falseBargeIns: number;
  timing: Record<string, number> | undefined;
  endReason: string | undefined;
}

export interface NoticeView {
  at: number;
  kind: "info" | "error";
  text: string;
}

/** A transient feedback bubble: info auto-dismisses, errors stay until clicked. */
export interface ToastView {
  id: number;
  kind: "info" | "error";
  text: string;
}

/** One generation result: the prompt, the audio (object URL), and how it was made. */
export interface TakeView {
  id: string;
  text: string;
  voice: string;
  at: number;
  url: string;
}

interface StudioState {
  connection: ConnectionState;
  sessionState: string;
  sessionId: string | undefined;
  active: boolean;
  muted: boolean;
  /** Local microphone RMS mapped to 0..1 — capture feedback, never sent anywhere. */
  micLevel: number;
  turns: TurnView[];
  notices: NoticeView[];
  capability: EndpointCapability | undefined;
  voice: string;
  /** The engine owning the conversation voice; routes the session's TTS when set. */
  voiceEngine: string;
  /** Generation takes, newest first. Object URLs are revoked on eviction/removal. */
  takes: TakeView[];
  voicesList: VoiceEntry[];
  /** The 生成 panel's voice (and owning engine), settable from the 音色 bank. */
  generateVoice: string;
  generateEngine: string;

  setGenerateVoice(voice: string, engine?: string): void;
  addTake(take: TakeView): void;
  removeTake(id: string): void;
  setVoicesList(voices: VoiceEntry[]): void;
  setConnection(connection: ConnectionState): void;
  setActive(active: boolean): void;
  setMuted(muted: boolean): void;
  setMicLevel(level: number): void;
  /** Clear the finished conversation's turns and notices — back to the start card. */
  clearHistory(): void;
  setCapability(capability: EndpointCapability): void;
  setVoice(voice: string, engine?: string): void;
  notice(kind: NoticeView["kind"], text: string): void;
  toasts: ToastView[];
  toast(kind: ToastView["kind"], text: string): void;
  dismissToast(id: number): void;
  apply(event: GatewayEvent): void;
  resetSession(): void;
}

const maxTurns = 50;
const maxNotices = 30;
const maxTakes = 30;
const maxToasts = 5;

let nextToastId = 1;

function updateTurn(turns: TurnView[], turnId: string, update: (turn: TurnView) => TurnView): TurnView[] {
  const index = turns.findIndex(turn => turn.id === turnId);
  if (index < 0) return turns;
  const next = [...turns];
  next[index] = update(turns[index] as TurnView);
  return next;
}

/**
 * The event reducer: protocol v1 events in, caption/turn view out. Framework-free on
 * purpose — this is the part of the panel that must track the session contract exactly,
 * so it lives where the root typecheck and bun tests reach it.
 */
export function reduceEvent(state: Pick<StudioState, "turns" | "notices" | "sessionState" | "sessionId">, event: GatewayEvent): Partial<StudioState> {
  const withNotice = (kind: NoticeView["kind"], text: string): Partial<StudioState> => ({
    notices: [...state.notices, { at: event.timestampMs, kind, text }].slice(-maxNotices),
  });
  switch (event.type) {
    case "session.state":
      return { sessionState: event.state, sessionId: event.sessionId };
    case "turn.started": {
      const turn: TurnView = {
        id: event.turnId,
        at: Date.now(),
        revision: 0,
        transcript: undefined,
        reply: "",
        status: "capturing",
        // The client clock, not event.timestampMs: elapsed-time UI compares against
        // Date.now(), and the server clock may skew when the gateway is remote.
        statusAt: Date.now(),
        reopens: 0,
        falseBargeIns: 0,
        timing: undefined,
        endReason: undefined,
      };
      return { turns: [...state.turns, turn].slice(-maxTurns) };
    }
    case "vad.end":
      return { turns: updateTurn(state.turns, event.turnId, turn => ({ ...turn, status: "thinking", statusAt: Date.now() })) };
    case "turn.reopened":
      // The superseded dispatch is dead; its partial transcript/reply would be stale.
      return {
        turns: updateTurn(state.turns, event.turnId, turn => ({
          ...turn,
          revision: event.revision ?? turn.revision + 1,
          transcript: undefined,
          reply: "",
          status: "capturing",
          statusAt: Date.now(),
          reopens: turn.reopens + 1,
        })),
      };
    case "transcript.final":
      return {
        turns: updateTurn(state.turns, event.turnId, turn =>
          event.revision < turn.revision ? turn : { ...turn, transcript: event.text }),
      };
    case "response.text.delta":
      return {
        turns: updateTurn(state.turns, event.turnId, turn =>
          event.revision < turn.revision ? turn : { ...turn, reply: turn.reply + event.text }),
      };
    case "response.text.final":
      return {
        turns: updateTurn(state.turns, event.turnId, turn =>
          event.revision < turn.revision ? turn : { ...turn, reply: event.text }),
      };
    case "playback.format":
      return { turns: updateTurn(state.turns, event.turnId, turn => ({ ...turn, status: "speaking", statusAt: Date.now() })) };
    case "turn.completed":
      return { turns: updateTurn(state.turns, event.turnId, turn => ({ ...turn, status: "completed", statusAt: Date.now() })) };
    case "turn.interrupted":
      return {
        turns: updateTurn(state.turns, event.turnId, turn => ({
          ...turn,
          status: "interrupted",
          statusAt: Date.now(),
          endReason: event.reason ?? "cancel",
        })),
      };
    case "turn.false_barge_in":
      return {
        turns: updateTurn(state.turns, event.turnId, turn => ({ ...turn, falseBargeIns: turn.falseBargeIns + 1 })),
      };
    case "turn.timing":
      return {
        turns: updateTurn(state.turns, event.turnId, turn => ({
          ...turn,
          timing: { ...event.offsetsMs } as Record<string, number>,
          endReason: event.endReason,
        })),
      };
    case "session.notice":
      return withNotice("info", event.message);
    case "error":
      return withNotice("error", `${event.code}: ${event.message}`);
    case "command.rejected":
      return event.reason === "stale_turn" ? {} : withNotice("error", `command rejected: ${event.reason}`);
    case "audio.queue_overflow":
      return withNotice("error", "playback queue overflow; audio dropped");
    default:
      return {};
  }
}

export const useStudio = create<StudioState>((set, get) => ({
  connection: "disconnected",
  sessionState: "off",
  sessionId: undefined,
  active: false,
  muted: false,
  micLevel: 0,
  turns: [],
  notices: [],
  capability: undefined,
  voice: "",
  voiceEngine: "",
  takes: [],
  voicesList: [],
  generateVoice: "",
  generateEngine: "",

  setGenerateVoice: (generateVoice, engine) => set({ generateVoice, generateEngine: engine ?? "" }),
  addTake: take =>
    set(state => {
      const next = [take, ...state.takes];
      for (const evicted of next.slice(maxTakes)) URL.revokeObjectURL(evicted.url);
      return { takes: next.slice(0, maxTakes) };
    }),
  removeTake: id =>
    set(state => {
      const removed = state.takes.find(take => take.id === id);
      if (removed) URL.revokeObjectURL(removed.url);
      return { takes: state.takes.filter(take => take.id !== id) };
    }),
  setVoicesList: voicesList => set({ voicesList }),
  setConnection: connection => set({ connection }),
  setActive: active => set({ active }),
  setMuted: muted => set({ muted }),
  setMicLevel: micLevel => set({ micLevel }),
  clearHistory: () => set({ turns: [], notices: [] }),
  setCapability: capability => set({ capability }),
  setVoice: (voice, engine) => set({ voice, voiceEngine: engine ?? "" }),
  notice: (kind, text) =>
    set(state => ({ notices: [...state.notices, { at: Date.now(), kind, text }].slice(-maxNotices) })),
  toasts: [],
  toast: (kind, text) =>
    set(state => ({ toasts: [...state.toasts, { id: nextToastId++, kind, text }].slice(-maxToasts) })),
  dismissToast: id => set(state => ({ toasts: state.toasts.filter(toast => toast.id !== id) })),
  apply: event => set(reduceEvent(get(), event)),
  resetSession: () => set({ sessionState: "off", sessionId: undefined, active: false, muted: false, micLevel: 0 }),
}));
