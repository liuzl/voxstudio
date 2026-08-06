import { describe, expect, test } from "bun:test";
import { writeWav } from "@voxstudio/audio";
import { FakeAgentExecutor, type AgentInput } from "@voxstudio/agent-executor";
import { DuplexSession, EnergyVadSegmenter } from "@voxstudio/duplex-session";
import { runConversation, type ConversationControls } from "@voxstudio/conversation";
import { AgentRunController } from "./agent-run-controller";
import { createAgentSpeechSink } from "./agent-speech-sink";

const chunking = {
  maxSeconds: 15, firstMaxSeconds: 8, growth: 2, sentenceEnders: "。！？.!?",
  joinPauseMs: 210, trimFloorDb: 25, edgePadMs: 40,
};
const ttsDefaults = { voice: "demo", cfgValue: 2, timesteps: 10, responseFormat: "wav" as const };
const context = { runId: "run-1", sessionId: "session-1", userId: "user-1" };
const input: AgentInput = { inputId: "input-1", text: "do the task" };

function fakeControls(): {
  controls: ConversationControls;
  queued: { text: string }[];
  clears: () => number;
} {
  const queued: { text: string }[] = [];
  let clears = 0;
  const controls: ConversationControls = {
    submitUserText: () => false,
    queueAgentSpeech: text => { queued.push({ text }); },
    clearQueuedAgentSpeech: () => {
      clears += 1;
      queued.length = 0;
    },
    pendingAgentSpeech: () => queued.length,
  };
  return { controls, queued, clears: () => clears };
}

/** Drains the microtask-driven event loop of the controller. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe("agent speech sink (Phase A gateway wiring to the conversation channel)", () => {
  test("speak queues narration through queueAgentSpeech", () => {
    const { controls, queued } = fakeControls();
    const sink = createAgentSpeechSink(controls, () => {});
    sink.speak("milestone", "正在处理…");
    sink.speak("answer", "结果在这里");
    expect(queued.map(entry => entry.text)).toEqual(["正在处理…", "结果在这里"]);
  });

  test("cancelQueued drops queued narration and never interrupts playback", () => {
    const { controls, queued, clears } = fakeControls();
    let interrupts = 0;
    const sink = createAgentSpeechSink(controls, () => { interrupts += 1; });
    sink.speak("milestone", "进度一");
    sink.speak("milestone", "进度二");
    sink.cancelQueued();
    expect(clears()).toBe(1);
    expect(queued).toEqual([]);
    expect(interrupts).toBe(0);
  });

  test("stop drops queued narration and interrupts current playback", () => {
    const { controls, queued, clears } = fakeControls();
    let interrupts = 0;
    const sink = createAgentSpeechSink(controls, () => { interrupts += 1; });
    sink.speak("answer", "正在说");
    sink.stop();
    expect(clears()).toBe(1);
    expect(queued).toEqual([]);
    expect(interrupts).toBe(1);
  });

  test("a fake-executor run narrates a milestone and completes through the real conversation channel", async () => {
    const session = new DuplexSession();
    session.start();
    let controls: ConversationControls | undefined;
    let releaseFrames = (): void => {};
    const frameGate = new Promise<void>(resolve => { releaseFrames = resolve; });
    const played: number[] = [];

    const running = runConversation({
      session,
      vad: new EnergyVadSegmenter({ sampleRate: 16_000, threshold: 0.1, minSpeechMs: 40, silenceMs: 20 }),
      frames: (async function* () {
        await frameGate;
        yield { samples: new Float32Array(320), timestampMs: 0 };
      })(),
      createPlayer: () => ({
        write: async audio => { played.push(audio.samples.length); },
        close: async () => {},
      }),
      asr: { transcribe: async () => ({ text: "" }) },
      llm: { chatStream: async function* () {} },
      tts: { speech: async () => new Uint8Array(writeWav(new Float32Array(24_000).fill(0.1), 24_000)) },
    }, {
      language: "zh", chunking, ttsDefaults, voice: "demo",
      allowBargeIn: true, turnTaking: "conservative", reopenMs: 7_000,
      onControls: value => { controls = value; },
    }, {
      onTranscript: () => {},
    });

    expect(controls).toBeDefined();
    const sink = createAgentSpeechSink(controls!, () => { session.interrupt("barge_in"); });
    const executor = new FakeAgentExecutor();
    const terminal: ("completed" | "failed" | "cancelled")[] = [];
    const controller = new AgentRunController({
      executor,
      speech: sink,
      input,
      context,
      onTerminal: state => terminal.push(state),
    });
    const run = executor.runs[0]!;
    await flush();

    // The executor run emits a progress milestone; the sink queues it for speech.
    run.emit({ type: "tool.started", invocationId: "call-1", name: "search" });
    await flush();
    expect(controls!.pendingAgentSpeech()).toBe(1);

    // Draining the loop narrates the queued milestone as an agent turn, then the
    // controller run finishes normally.
    run.complete();
    releaseFrames();
    await running;
    await controller.drained;

    expect(played.length).toBeGreaterThan(0);
    expect(terminal).toEqual(["completed"]);
    expect(controls!.pendingAgentSpeech()).toBe(0);
    expect(session.state).toBe("listening");
  });
});
