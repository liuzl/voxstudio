import type { GatewayEvent } from "@voxstudio/realtime-gateway/protocol";
import { create } from "zustand";
import type { EndpointCapability } from "./lib/audio";
import type { ConnectionState } from "./lib/client";

export interface TurnView {
  id: string;
  revision: number;
  transcript: string | undefined;
  reply: string;
  status: "capturing" | "thinking" | "speaking" | "completed" | "interrupted";
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
  turns: TurnView[];
  notices: NoticeView[];
  capability: EndpointCapability | undefined;
  voice: string;
  language: string;
  /** Generation takes, newest first. Object URLs are revoked on eviction/removal. */
  takes: TakeView[];
  voicesList: string[];
  /** The 生成 panel's voice, settable from the 音色 bank. */
  generateVoice: string;

  setGenerateVoice(voice: string): void;
  addTake(take: TakeView): void;
  removeTake(id: string): void;
  setVoicesList(voices: string[]): void;
  setConnection(connection: ConnectionState): void;
  setActive(active: boolean): void;
  setMuted(muted: boolean): void;
  setCapability(capability: EndpointCapability): void;
  setVoice(voice: string): void;
  setLanguage(language: string): void;
  notice(kind: NoticeView["kind"], text: string): void;
  apply(event: GatewayEvent): void;
  resetSession(): void;
}

const maxTurns = 50;
const maxNotices = 30;
const maxTakes = 30;

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
        revision: 0,
        transcript: undefined,
        reply: "",
        status: "capturing",
        reopens: 0,
        falseBargeIns: 0,
        timing: undefined,
        endReason: undefined,
      };
      return { turns: [...state.turns, turn].slice(-maxTurns) };
    }
    case "vad.end":
      return { turns: updateTurn(state.turns, event.turnId, turn => ({ ...turn, status: "thinking" })) };
    case "turn.reopened":
      // The superseded dispatch is dead; its partial transcript/reply would be stale.
      return {
        turns: updateTurn(state.turns, event.turnId, turn => ({
          ...turn,
          revision: event.revision ?? turn.revision + 1,
          transcript: undefined,
          reply: "",
          status: "capturing",
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
      return { turns: updateTurn(state.turns, event.turnId, turn => ({ ...turn, status: "speaking" })) };
    case "turn.completed":
      return { turns: updateTurn(state.turns, event.turnId, turn => ({ ...turn, status: "completed" })) };
    case "turn.interrupted":
      return {
        turns: updateTurn(state.turns, event.turnId, turn => ({
          ...turn,
          status: "interrupted",
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
  turns: [],
  notices: [],
  capability: undefined,
  voice: "",
  language: "zh",
  takes: [],
  voicesList: [],
  generateVoice: "",

  setGenerateVoice: generateVoice => set({ generateVoice }),
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
  setCapability: capability => set({ capability }),
  setVoice: voice => set({ voice }),
  setLanguage: language => set({ language }),
  notice: (kind, text) =>
    set(state => ({ notices: [...state.notices, { at: Date.now(), kind, text }].slice(-maxNotices) })),
  apply: event => set(reduceEvent(get(), event)),
  resetSession: () => set({ sessionState: "off", sessionId: undefined, active: false, muted: false }),
}));
