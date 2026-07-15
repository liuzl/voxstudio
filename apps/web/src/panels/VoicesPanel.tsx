import { writeWav } from "@voxstudio/audio";
import { useEffect, useRef, useState } from "react";
import { deleteVoice, listVoices, registerVoice, synthesize, transcribe } from "../lib/api";
import { VoiceRecorder } from "../lib/audio";
import { useStudio } from "../store";

const auditionText = "你好，这是一段试听。今天天气不错。";
const maxRecordMs = 30_000;
const minRecordMs = 2_000;

export function VoicesPanel() {
  const voicesList = useStudio(state => state.voicesList);
  const setVoicesList = useStudio(state => state.setVoicesList);
  const [status, setStatus] = useState<{ kind: "info" | "error"; text: string } | undefined>(undefined);
  const [auditioning, setAuditioning] = useState("");
  const [registering, setRegistering] = useState(false);
  const [newId, setNewId] = useState("");
  const [newText, setNewText] = useState("");
  const [source, setSource] = useState<"upload" | "record">("upload");
  const [recorder, setRecorder] = useState<VoiceRecorder | undefined>(undefined);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recorded, setRecorded] = useState<{ file: File; url: string } | undefined>(undefined);
  const [transcribing, setTranscribing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const player = useRef<HTMLAudioElement | undefined>(undefined);

  const refresh = () =>
    listVoices()
      .then(setVoicesList)
      .catch(error => setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) }));

  useEffect(() => {
    void refresh();
    return () => player.current?.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const audition = async (id: string) => {
    setAuditioning(id);
    setStatus(undefined);
    try {
      const url = await synthesize({ input: auditionText, voice: id });
      player.current?.pause();
      const audio = new Audio(url);
      player.current = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setAuditioning("");
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(`删除音色 ${id}？引擎侧的参考音会一并删除。`)) return;
    try {
      await deleteVoice(id);
      setStatus({ kind: "info", text: `已删除 ${id}` });
      await refresh();
    } catch (error) {
      // Fixed-bank engines (kokoro) have no registry; the facade passes their refusal through.
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const discardRecording = () => {
    if (recorded) URL.revokeObjectURL(recorded.url);
    setRecorded(undefined);
  };

  const startRecording = async () => {
    setStatus(undefined);
    discardRecording();
    try {
      const next = await VoiceRecorder.start();
      setRecorder(next);
      setElapsedMs(0);
    } catch (error) {
      setStatus({ kind: "error", text: `无法开始录音：${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const stopRecording = async (active: VoiceRecorder) => {
    setRecorder(undefined);
    const samples = await active.stop();
    if (samples.length < minRecordMs * 16) {
      setStatus({ kind: "error", text: "录音太短：参考音需要至少 2 秒（建议 5–15 秒）。" });
      return;
    }
    const wav = writeWav(samples, 16_000);
    const file = new File([new Uint8Array(wav)], "recorded-ref.wav", { type: "audio/wav" });
    setRecorded({ file, url: URL.createObjectURL(file) });
  };

  useEffect(() => {
    if (!recorder) return;
    const timer = setInterval(() => {
      setElapsedMs(recorder.elapsedMs);
      // A reference sample past 30s helps nothing; stop rather than grow silently.
      if (recorder.elapsedMs >= maxRecordMs) void stopRecording(recorder);
    }, 200);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder]);

  const referenceFile = (): File | undefined =>
    source === "record" ? recorded?.file : fileInput.current?.files?.[0];

  const fillTranscript = async () => {
    const file = referenceFile();
    if (!file) {
      setStatus({ kind: "error", text: "先录制或选择参考音频，再识别逐字稿。" });
      return;
    }
    setTranscribing(true);
    setStatus(undefined);
    try {
      const text = await transcribe(file, "zh");
      if (!text) setStatus({ kind: "error", text: "ASR 没有识别出内容；请人工填写逐字稿。" });
      setNewText(text);
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTranscribing(false);
    }
  };

  const register = async () => {
    const file = referenceFile();
    if (!newId.trim() || !newText.trim() || !file) {
      setStatus({ kind: "error", text: "注册需要：ID、参考音频（上传或录制）、参考音的逐字稿。" });
      return;
    }
    setRegistering(true);
    setStatus(undefined);
    try {
      await registerVoice(newId.trim(), newText.trim(), file);
      setStatus({ kind: "info", text: `已注册 ${newId.trim()}` });
      setNewId("");
      setNewText("");
      if (fileInput.current) fileInput.current.value = "";
      discardRecording();
      await refresh();
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setRegistering(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-8 md:py-10">
      <h1 className="text-2xl font-semibold">音色</h1>
      {status && (
        <p className={`text-xs ${status.kind === "error" ? "text-red-300" : "text-emerald-300"}`}>{status.text}</p>
      )}

      <section className="rounded-xl border border-ink-700 bg-ink-900 p-4 md:p-5">
        <h2 className="text-sm font-medium text-ink-300">音色库（{voicesList.length}）</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {voicesList.length === 0 && <p className="text-sm text-ink-500">引擎没有返回音色；克隆型引擎可用下方表单注册。</p>}
          {voicesList.map(id => (
            <span key={id} className="flex items-center gap-1 rounded-full border border-ink-700 bg-ink-800 py-1 pl-3 pr-1 text-xs">
              {id}
              <button
                onClick={() => void audition(id)}
                disabled={auditioning !== ""}
                className="rounded-full px-1.5 py-0.5 text-ink-300 hover:text-accent-500 disabled:opacity-40"
                title="试听"
              >
                {auditioning === id ? "…" : "▶"}
              </button>
              <button
                onClick={() => void remove(id)}
                className="rounded-full px-1.5 py-0.5 text-ink-300 hover:text-red-300"
                title="删除"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-ink-700 bg-ink-900 p-4 md:p-5">
        <h2 className="text-sm font-medium text-ink-300">注册音色（克隆型引擎）</h2>
        <p className="mt-1 text-[11px] text-ink-500">
          5–15 秒干净的参考音频（上传或现场录制），配上与音频逐字对应的文本；逐字稿可先用 ASR 识别再修正。
        </p>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <input
              value={newId}
              onChange={event => setNewId(event.target.value)}
              placeholder="音色 ID（字母数字._-）"
              className="w-44 rounded border border-ink-700 bg-ink-800 px-2 py-1.5 text-xs text-ink-100"
            />
            <div className="flex overflow-hidden rounded-lg border border-ink-700 text-xs">
              {(["upload", "record"] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setSource(mode)}
                  className={`px-3 py-1.5 ${source === mode ? "bg-ink-700 text-ink-100" : "text-ink-300 hover:text-ink-100"}`}
                >
                  {mode === "upload" ? "上传文件" : "现场录制"}
                </button>
              ))}
            </div>
          </div>

          {source === "upload" ? (
            <input
              ref={fileInput}
              type="file"
              accept="audio/*"
              className="text-xs text-ink-300 file:mr-2 file:rounded file:border-0 file:bg-ink-700 file:px-2 file:py-1.5 file:text-xs file:text-ink-100"
            />
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              {recorder ? (
                <button
                  onClick={() => void stopRecording(recorder)}
                  className="flex items-center gap-2 rounded-lg bg-red-500/90 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
                >
                  <span className="inline-block size-2 animate-pulse rounded-full bg-white" />
                  停止（{(elapsedMs / 1_000).toFixed(1)}s / 30s）
                </button>
              ) : (
                <button
                  onClick={() => void startRecording()}
                  className="rounded-lg border border-ink-700 px-4 py-2 text-sm text-ink-100 hover:bg-ink-800"
                >
                  {recorded ? "重新录制" : "🎙 开始录制"}
                </button>
              )}
              {recorded && !recorder && (
                <>
                  <audio controls src={recorded.url} className="h-9 max-w-64" />
                  <span className="text-[11px] text-ink-500">{(recorded.file.size / 32_000).toFixed(1)}s · 16kHz WAV</span>
                </>
              )}
            </div>
          )}

          <div className="flex items-start gap-2">
            <textarea
              value={newText}
              onChange={event => setNewText(event.target.value)}
              rows={2}
              placeholder="参考音的逐字稿…"
              className="w-full flex-1 rounded border border-ink-700 bg-ink-800 px-2 py-1.5 text-xs text-ink-100"
            />
            <button
              onClick={() => void fillTranscript()}
              disabled={transcribing}
              className="shrink-0 rounded border border-ink-700 px-2 py-1.5 text-[11px] text-ink-300 hover:text-ink-100 disabled:opacity-40"
              title="用 ASR 识别参考音，生成逐字稿草稿"
            >
              {transcribing ? "识别中…" : "ASR 识别"}
            </button>
          </div>
          <div>
            <button
              onClick={() => void register()}
              disabled={registering || recorder !== undefined}
              className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white hover:bg-accent-500 disabled:opacity-40"
            >
              {registering ? "注册中…" : "注册"}
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-ink-700 bg-ink-900 p-4 text-sm leading-relaxed text-ink-300 md:p-5">
        <h2 className="text-sm font-medium">设计档（design profiles）</h2>
        <p className="mt-2 text-xs text-ink-500">
          SHA-256 指纹徽章、audit / reproduce / verify / audition 流程需要网关侧的设计档注册表——
          目前设计档存于 CLI 本地，随 Phase 3 的网关注册表落地后在此展开（见 docs/web-studio.md）。
        </p>
      </section>
    </div>
  );
}
