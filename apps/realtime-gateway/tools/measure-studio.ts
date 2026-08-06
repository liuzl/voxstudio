#!/usr/bin/env bun
/**
 * The Studio tools gate (docs/voice-studio-control.md §Phases 2): the real conversation
 * loop against the live LLM and live TTS engine — scripted audio and ASR (those have
 * their own gates), everything else production code. Three flows, all thresholds hard:
 *
 *   - a mispronounced term is corrected mid-conversation by voice, and the very next
 *     reply is SYNTHESIZED with the corrected reading while the caption keeps the
 *     spelling;
 *   - redo re-speaks the previous reply as an agent turn in the requested voice;
 *   - the save parks, asks aloud, and registers the park-time utterance on the real
 *     engine only after "确认" — verified by reading the voice back, then cleaned up.
 *
 *   bun run measure:studio [--config CONFIG]
 */
import { auditDesignProfile, LlmClient, TtsClient } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { SpeechInput } from "@voxstudio/contracts";
import { DuplexSession, EnergyVadSegmenter } from "@voxstudio/duplex-session";
import {
  createStudioReferents,
  createStudioTools,
  runConversation,
  type ConversationControls,
  type ConversationFrame,
} from "@voxstudio/conversation";
import { applyPronunciations, sanitizeForTts } from "@voxstudio/text";
import { loadConfig, persistPronunciationsFile } from "@voxstudio/platform-bun";

const GATE_VOICE_ID = "gate-studio-tmp";

async function main(): Promise<number> {
  const explicitIndex = process.argv.indexOf("--config");
  const config = explicitIndex >= 0
    ? await loadConfig({ explicit: process.argv[explicitIndex + 1] as string })
    : await loadConfig();
  const llm = new LlmClient(engine(config, "llm"));
  const tts = new TtsClient(engine(config, "tts"));

  // Two real voices from the live bank: one to converse in, one for the redo override.
  const bank = await tts.listVoices();
  if (bank.some(voice => voice.id === GATE_VOICE_ID)) {
    // Never adopt-and-delete someone's voice that happens to share the gate's id.
    console.error(`STUDIO GATE: REFUSED (${GATE_VOICE_ID} already exists on the engine; delete it first if it is a leftover)`);
    return 1;
  }
  const voices = bank.map(voice => voice.id);
  if (voices.length < 2) {
    console.error(`STUDIO GATE: SKIP (need two registered voices, found ${voices.length})`);
    return 1;
  }
  const baseVoice = voices[0] as string;
  const redoVoice = voices[1] as string;

  const failures: string[] = [];
  const check = (ok: boolean, what: string, detail: string): void => {
    console.error(`${ok ? "✓" : "✗"} ${what} -> ${detail}`);
    if (!ok) failures.push(what);
  };

  // The live TTS behind a recorder: every synthesis request the loop makes is evidence.
  const synthesized: { input: string; voice?: string }[] = [];
  const speechEngine = {
    speech: async (input: SpeechInput, signal?: AbortSignal): Promise<ArrayBuffer | Uint8Array> => {
      synthesized.push({
        input: input.input,
        ...(input.voice === undefined ? {} : { voice: input.voice }),
      });
      return tts.speech(input, signal);
    },
  };

  const designProfileId = bank.find(voice => voice.design_profile !== undefined)?.id;
  const transcripts = [
    "记住，VoxCPM 这个词要读作 vox-c-p-m",
    "请用一句话介绍 VoxCPM",
    `用 ${redoVoice} 的声音把刚才那句再念一遍`,
    "这是一句用来克隆声音的样本话语。",
    `把我刚才那句话存成音色样本，就叫 ${GATE_VOICE_ID}`,
    "确认",
    "把这些发音保存下来，以后都这么读",
    "确认",
    `用 ${baseVoice} 的声音生成一句「门禁测试」`,
    ...(designProfileId === undefined ? [] : [`检查一下 ${designProfileId} 这个音色有没有漂移`]),
  ];
  const events: string[] = [];
  const replies: string[] = [];
  const pronunciations: Record<string, string> = {};
  const scratchConfig = `${process.env.TMPDIR ?? "/tmp"}/gate-studio-config-${Date.now()}.yaml`;
  await Bun.write(scratchConfig, "# gate scratch config\nengines:\n  tts:\n    base_url: http://placeholder  # keep\n");
  const referents = createStudioReferents();
  let controls: ConversationControls | undefined;
  let registeredTranscript: string | undefined;

  const tools = createStudioTools({
    lastUtterance: referents.lastUtterance,
    lastReply: referents.lastReply,
    queueAgentSpeech: (text, overrides) => controls?.queueAgentSpeech(text, overrides),
    setPronunciation: (term, reading) => {
      pronunciations[term] = reading;
      events.push(`pronounce:${term}=${reading}`);
    },
    registerVoice: async (id, wav, transcript) => {
      registeredTranscript = transcript;
      events.push(`register:${id}`);
      await tts.createVoice(id, transcript, new Blob([wav as BlobPart], { type: "audio/wav" }), "utterance.wav");
      referents.clearPin();
    },
    // The persist flow writes a REAL file through the REAL surgery+validation path —
    // just not the operator's config: a scratch copy stands in for it.
    persistPronunciations: async entries => {
      await persistPronunciationsFile(scratchConfig, entries);
      events.push(`persist:${Object.keys(entries).join(",")}`);
    },
    generateTake: async (text, voice) => {
      events.push(`take:${text}@${voice ?? ""}`);
      return { location: "gate" };
    },
    auditProfile: async id => {
      const verdict = await auditDesignProfile(tts, id);
      if (verdict.status !== "not_found") events.push(`audit:${id}:${verdict.status}`);
      return verdict;
    },
  });

  const session = new DuplexSession();
  session.start();
  let turn = 0;
  let done = false;

  /** One ~0.5s speech burst per utterance, paced on the session settling; then silence
   * until the redo/save flows finish (the agent turn drains at an idle gap). */
  const frames = (async function* (): AsyncIterable<ConversationFrame> {
    // Every wait treats `closed` as an exit: the watchdog ends the session from outside,
    // and a generator still awaiting `listening` would deadlock the whole gate.
    const closed = (): boolean => session.snapshot().state === "closed";
    const wait = (predicate: () => boolean): Promise<void> => new Promise(resolve => {
      const poll = (): void => { (predicate() || closed()) ? resolve() : setTimeout(poll, 20); };
      poll();
    });
    for (let index = 0; index < transcripts.length && !closed(); index += 1) {
      const t = index * 60_000;
      for (let f = 0; f < 25; f += 1) yield { samples: new Float32Array(320).fill(0.2), timestampMs: t + f * 20 };
      // Enough trailing silence to clear silenceMs, or speech never ends and the settle
      // wait below deadlocks the whole gate.
      for (let f = 0; f < 10; f += 1) yield { samples: new Float32Array(320), timestampMs: t + 500 + f * 20 };
      await wait(() => session.snapshot().state !== "listening");
      await wait(() => session.snapshot().state === "listening");
      // After the redo command, play the part of a user who waits to listen: the re-speak
      // is a queued agent turn draining at the next idle gap, and speaking over it is a
      // (correct) barge-in that would abort it. Silence flows until it has played out.
      if (index === 2) {
        const redoDeadline = Date.now() + 60_000;
        let quiet = (index + 1) * 60_000 - 30_000;
        while (Date.now() < redoDeadline && !closed()
          && !(synthesized.some(piece => piece.voice === redoVoice) && session.snapshot().state === "listening")) {
          yield { samples: new Float32Array(320), timestampMs: quiet };
          quiet += 20;
          await Bun.sleep(20);
        }
      }
    }
    const deadline = Date.now() + 120_000;
    let t = transcripts.length * 60_000;
    while (!done && !closed() && Date.now() < deadline) {
      yield { samples: new Float32Array(320), timestampMs: t };
      t += 20;
      await Bun.sleep(20);
    }
  })();

  const conversation = runConversation({
    session,
    vad: new EnergyVadSegmenter({ sampleRate: 16_000, threshold: 0.1, minSpeechMs: 100, silenceMs: 60 }),
    frames,
    createPlayer: () => ({ write: async () => {}, close: async () => {} }),
    asr: { transcribe: async () => ({ text: transcripts[Math.min(turn++, transcripts.length - 1)] as string }) },
    llm,
    tts: speechEngine,
  }, {
    language: "zh", chunking: config.chunking, ttsDefaults: config.ttsDefaults, voice: baseVoice,
    allowBargeIn: true, turnTaking: "conservative", reopenMs: 7_000,
    tools, pronunciations,
    onControls: handle => { controls = handle; },
  }, {
    onTranscript: text => console.error(`  [user] ${text}`),
    onReply: text => { referents.recordReply(text); replies.push(text); console.error(`  [agent] ${text.slice(0, 60)}`); },
    onUtterance: async utterance => { referents.recordUtterance(utterance.wav, utterance.rawTranscript); },
    onToolCall: (name, args) => events.push(`call:${name}:${JSON.stringify(args)}`),
    onToolPending: name => { referents.onToolPending(name); events.push(`pending:${name}`); },
    onToolResult: (name, ok) => events.push(`result:${name}:${ok}`),
    onError: (code, message) => events.push(`error:${code}:${message}`),
  });

  // The gate ends the conversation once the register lands (or the deadline passes).
  const watchdog = (async (): Promise<void> => {
    const deadline = Date.now() + 420_000;
    while (Date.now() < deadline) {
      const redoDone = synthesized.some(piece => piece.voice === redoVoice);
      const saveDone = events.some(entry => entry.startsWith("register:"));
      const persistDone = events.some(entry => entry.startsWith("persist:"));
      const takeDone = events.some(entry => entry.startsWith("take:"));
      const auditDone = designProfileId === undefined || events.some(entry => entry.startsWith("audit:"));
      if ((redoDone && saveDone && persistDone && takeDone && auditDone)
        || events.some(entry => entry.startsWith("error:"))) break;
      await Bun.sleep(250);
    }
    await Bun.sleep(3_000); // let the closing reply finish synthesizing
    done = true;
    session.close();
  })();
  await Promise.allSettled([conversation, watchdog]);

  try {
    // ---- pronunciation: corrected mid-conversation, spoken right the next reply ----
    const overlay = Object.entries(pronunciations);
    check(overlay.length > 0 && overlay.some(([term]) => term.includes("VoxCPM")),
      "remember_pronunciation stored a usable overlay", JSON.stringify(pronunciations));
    const reading = overlay.find(([term]) => term.includes("VoxCPM"))?.[1] ?? "";
    const reply2 = replies[1] ?? "";
    check(reply2.includes("VoxCPM"), "the caption keeps the spelling", `"${reply2.slice(0, 50)}"`);
    const reply2Synth = synthesized.filter(piece => piece.voice === baseVoice)
      .map(piece => piece.input).join("");
    check(reading !== "" && reply2Synth.includes(reading) && !reply2Synth.includes("VoxCPM"),
      "the next reply is synthesized with the corrected reading", `reading="${reading}"`);

    // ---- redo: the previous reply re-spoken in the requested voice -----------------
    const redoPieces = synthesized.filter(piece => piece.voice === redoVoice);
    const expected = sanitizeForTts(applyPronunciations(reply2, pronunciations)).text.replace(/\s+/g, "");
    check(redoPieces.length > 0
      && redoPieces.map(piece => piece.input).join("").replace(/\s+/g, "") === expected,
      "redo re-speaks the previous reply in the override voice",
      `${redoPieces.length} piece(s) as ${redoVoice}`);

    // ---- save: parked, asked, executed on 确认, on the real engine -----------------
    const pendingIndex = events.findIndex(entry => entry === "pending:save_last_utterance_as_voice");
    const registerIndex = events.findIndex(entry => entry.startsWith("register:"));
    check(pendingIndex >= 0, "the save parked and asked aloud", events[pendingIndex] ?? "no pending event");
    check(registerIndex > pendingIndex && registerIndex >= 0,
      "registration happened only after the spoken confirmation",
      JSON.stringify(events.filter(entry => entry.startsWith("pending:") || entry.startsWith("register:"))));
    check(registeredTranscript === transcripts[3],
      "the registered audio is the park-time sample, not the command or the confirmation",
      `transcript="${registeredTranscript ?? ""}"`);
    const onEngine = await tts.getVoice(GATE_VOICE_ID).then(() => true).catch(() => false);
    check(onEngine, "the voice exists on the live engine", GATE_VOICE_ID);

    // ---- persist: confirmed aloud, written through the real surgery, comments intact --
    const persistPending = events.indexOf("pending:persist_pronunciations");
    const persistIndex = events.findIndex(entry => entry.startsWith("persist:"));
    check(persistPending >= 0 && persistIndex > persistPending,
      "persist parked, asked, and executed only on the confirmation", JSON.stringify(events.filter(entry => entry.includes("persist"))));
    const scratch = await Bun.file(scratchConfig).text().catch(() => "");
    const scratchParsed = Bun.YAML.parse(scratch) as { pronunciations?: Record<string, string> } | null;
    check(scratchParsed?.pronunciations?.VoxCPM === (pronunciations.VoxCPM ?? "")
      && scratch.includes("# keep"),
      "the config file gained the overlay and kept its comments",
      JSON.stringify(scratchParsed?.pronunciations ?? {}));

    // ---- generate_take: routed with the text and voice, produced where the surface says
    check(events.some(entry => entry.startsWith("take:") && entry.includes("门禁测试") && entry.endsWith(`@${baseVoice}`)),
      "generate_take carries the text and the requested voice",
      events.find(entry => entry.startsWith("take:")) ?? "no take event");

    // ---- audit: a definite verdict against the live runtime -------------------------
    if (designProfileId === undefined) {
      console.error("  (audit case skipped: no design profile on the engine)");
    } else {
      check(events.some(entry => entry.startsWith(`audit:${designProfileId}:`)),
        "audit_profile answered with a definite verdict against the live runtime",
        events.find(entry => entry.startsWith("audit:")) ?? "no audit event");
    }
    check(!events.some(entry => entry.startsWith("error:")), "no conversation errors",
      events.filter(entry => entry.startsWith("error:")).join("; ") || "clean");
  } finally {
    // Cleanup only what this run created; the pre-existence check above refused otherwise.
    if (events.some(entry => entry.startsWith("register:"))) {
      await tts.deleteVoice(GATE_VOICE_ID).catch(() => {});
    }
    await Bun.file(scratchConfig).delete().catch(() => {});
  }

  const pass = failures.length === 0;
  console.error(pass ? "STUDIO GATE: PASS" : `STUDIO GATE: FAIL (${failures.join("; ")})`);
  return pass ? 0 : 1;
}

process.exitCode = await main();
