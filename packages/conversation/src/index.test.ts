import { describe, expect, test } from "bun:test";
import { writeWav } from "@voxstudio/audio";
import { DuplexSession, EnergyVadSegmenter } from "@voxstudio/duplex-session";
import { runConversation, type ConversationFrame } from "./index";

const chunking = {
  maxSeconds: 15, firstMaxSeconds: 8, growth: 2, sentenceEnders: "。！？.!?",
  joinPauseMs: 210, trimFloorDb: 25, edgePadMs: 40,
};
const ttsDefaults = { voice: "demo", cfgValue: 2, timesteps: 10, responseFormat: "wav" as const };

function frames(): AsyncIterable<ConversationFrame> {
  return (async function* () {
    yield { samples: new Float32Array(320).fill(0.2), timestampMs: 0 };
    yield { samples: new Float32Array(320).fill(0.2), timestampMs: 20 };
    yield { samples: new Float32Array(320), timestampMs: 40 };
  })();
}

describe("runConversation", () => {
  test("runs one VAD-delimited turn through ASR, streaming LLM deltas, TTS, and callbacks", async () => {
    const session = new DuplexSession();
    const events: string[] = [];
    const deltas: string[] = [];
    const played: number[] = [];
    const utterances: { bytes: number; transcript: string }[] = [];
    let playerClosed = false;
    session.start();

    await runConversation({
      session,
      vad: new EnergyVadSegmenter({ sampleRate: 16_000, threshold: 0.1, minSpeechMs: 40, silenceMs: 20 }),
      frames: frames(),
      createPlayer: () => ({
        write: async audio => { played.push(audio.samples.length); },
        close: async () => { playerClosed = true; },
      }),
      asr: { transcribe: async () => ({ text: "你好" }) },
      llm: {
        chatStream: async function* () {
          yield "回答";
          yield "完毕。";
        },
      },
      tts: { speech: async () => new Uint8Array(writeWav(new Float32Array(48_000).fill(0.1), 24_000)) },
    }, {
      language: "zh", chunking, ttsDefaults, voice: "demo",
      allowBargeIn: true, turnTaking: "conservative", reopenMs: 7_000,
    }, {
      onTranscript: text => events.push(`transcript:${text}`),
      onReplyDelta: delta => deltas.push(delta),
      onReply: text => events.push(`reply:${text}`),
      onUtterance: (wav, transcript) => { utterances.push({ bytes: wav.length, transcript }); },
    });

    expect(events).toEqual(["transcript:你好", "reply:回答完毕。"]);
    expect(deltas).toEqual(["回答", "完毕。"]);
    expect(played).toEqual([48_000]);
    expect(playerClosed).toBe(true);
    expect(utterances).toHaveLength(1);
    expect(utterances[0]?.transcript).toBe("你好");
    expect(utterances[0]?.bytes).toBeGreaterThan(44);
    expect(session.state).toBe("listening");
  });

  test("closing the session mid-reply aborts the turn and stops the player", async () => {
    const session = new DuplexSession();
    let aborted = false;
    let releaseWrite = () => {};
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    session.start();

    await runConversation({
      session,
      vad: new EnergyVadSegmenter({ sampleRate: 16_000, threshold: 0.1, minSpeechMs: 40, silenceMs: 20 }),
      frames: (async function* () {
        yield* [
          { samples: new Float32Array(320).fill(0.2), timestampMs: 0 },
          { samples: new Float32Array(320).fill(0.2), timestampMs: 20 },
          { samples: new Float32Array(320), timestampMs: 40 },
        ];
        // The reply is audibly playing; shutting down now must abort it, not wait it out.
        await writeGate;
        session.close();
      })(),
      createPlayer: () => ({
        write: async () => { releaseWrite(); },
        close: async () => {},
        abort: async () => { aborted = true; },
      }),
      asr: { transcribe: async () => ({ text: "你好" }) },
      llm: { chatStream: async function* () { yield "回答。"; } },
      tts: {
        speech: async () => {
          await Bun.sleep(1);
          return new Uint8Array(writeWav(new Float32Array(48_000).fill(0.1), 24_000));
        },
      },
    }, {
      language: "zh", chunking, ttsDefaults, voice: "demo",
      allowBargeIn: true, turnTaking: "conservative", reopenMs: 7_000,
    });

    expect(aborted).toBe(true);
    expect(session.state).toBe("closed");
  });
});
