import { writeWav } from "@voxstudio/audio";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createDesignProfile,
  deleteVoice,
  listEngines,
  listVoices,
  registerVoice,
  synthesize,
  transcribe,
  type EngineEntry,
  type VoiceEntry,
} from "../lib/api";
import { VoiceRecorder } from "../lib/audio";
import { useStudio } from "../store";
import { useT, type MessageKey } from "../i18n";

// The audition sentence is TTS corpus, not UI copy: it follows the voice's own
// language (by bank prefix), not the UI locale.
const auditionTextZh = "你好，这是一段试听。今天天气不错。";
const auditionTextEn = "Hello, this is a quick audition. Lovely weather today.";

function auditionTextFor(id: string): string {
  return categoryOf(id).startsWith("英文") ? auditionTextEn : auditionTextZh;
}
const maxRecordMs = 30_000;
const minRecordMs = 2_000;

/**
 * Kokoro-style ids encode language and gender in their prefix; anything else in the bank
 * came from a clone/design engine — the user's own voices, the ones worth surfacing first.
 */
const categoryLabels: Record<string, MessageKey> = {
  zf: "中文·女", zm: "中文·男",
  af: "英文·女", am: "英文·男",
  bf: "英文·女(英)", bm: "英文·男(英)",
};
const ownCategory: MessageKey = "我的音色";

function categoryOf(id: string): MessageKey {
  const prefix = id.split("_")[0] ?? "";
  return categoryLabels[prefix] ?? ownCategory;
}

export function VoicesPanel() {
  const t = useT();
  const voicesList = useStudio(state => state.voicesList);
  const setVoicesList = useStudio(state => state.setVoicesList);
  const setGenerateVoice = useStudio(state => state.setGenerateVoice);
  const toast = useStudio(state => state.toast);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [auditioning, setAuditioning] = useState("");
  const [playing, setPlaying] = useState("");
  /** `${engine}/${id}` awaiting inline delete confirmation; auto-expires. */
  const [confirmDelete, setConfirmDelete] = useState("");
  const auditionSeq = useRef(0);
  const [registering, setRegistering] = useState(false);
  const [newId, setNewId] = useState("");
  const [newText, setNewText] = useState("");
  const [showRegister, setShowRegister] = useState(false);
  const [source, setSource] = useState<"upload" | "record">("upload");
  const [recorder, setRecorder] = useState<VoiceRecorder | undefined>(undefined);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recorded, setRecorded] = useState<{ file: File; url: string } | undefined>(undefined);
  /** Object URL of the chosen upload — audible before it becomes a reference voice. */
  const [uploaded, setUploaded] = useState<{ url: string; name: string } | undefined>(undefined);
  const [transcribing, setTranscribing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const player = useRef<HTMLAudioElement | undefined>(undefined);

  const refresh = () =>
    listVoices()
      .then(setVoicesList)
      .catch(error => toast("error", error instanceof Error ? error.message : String(error)));

  useEffect(() => {
    void refresh();
    return () => player.current?.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An unanswered inline delete prompt quietly puts the × back.
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(""), 4_000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  const stopAudition = () => {
    player.current?.pause();
    player.current = undefined;
    setPlaying("");
  };

  // Click to play, click again to stop; a newer pick supersedes an in-flight synthesis
  // instead of locking the whole bank behind it.
  const audition = async (id: string, engine: string) => {
    if (playing === id) {
      stopAudition();
      return;
    }
    const seq = ++auditionSeq.current;
    setAuditioning(id);
    try {
      const url = await synthesize({ input: auditionTextFor(id), voice: id, ...(engine ? { engine } : {}) });
      if (seq !== auditionSeq.current) {
        URL.revokeObjectURL(url);
        return;
      }
      stopAudition();
      const audio = new Audio(url);
      player.current = audio;
      setPlaying(id);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setPlaying(current => (current === id ? "" : current));
      };
      await audio.play();
    } catch (error) {
      if (seq === auditionSeq.current) {
        toast("error", error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (seq === auditionSeq.current) setAuditioning("");
    }
  };

  // Confirmation is inline on the item (no blocking dialog); this runs after it.
  const remove = async (id: string, engine: string) => {
    try {
      await deleteVoice(id, engine || undefined);
      toast("info", t("已删除 {id}", { id }));
      await refresh();
    } catch (error) {
      // Fixed-bank engines (kokoro) have no registry; the facade passes their refusal through.
      toast("error", error instanceof Error ? error.message : String(error));
    }
  };

  const discardRecording = () => {
    if (recorded) URL.revokeObjectURL(recorded.url);
    setRecorded(undefined);
  };

  const discardUpload = () => {
    if (uploaded) URL.revokeObjectURL(uploaded.url);
    setUploaded(undefined);
  };

  const startRecording = async () => {
    discardRecording();
    try {
      const next = await VoiceRecorder.start();
      setRecorder(next);
      setElapsedMs(0);
    } catch (error) {
      toast("error", t("无法开始录音：{error}", { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const stopRecording = async (active: VoiceRecorder) => {
    setRecorder(undefined);
    const samples = await active.stop();
    if (samples.length < minRecordMs * 16) {
      toast("error", t("录音太短：参考音需要至少 2 秒（建议 5–15 秒）。"));
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
      toast("error", t("先录制或选择参考音频，再识别逐字稿。"));
      return;
    }
    setTranscribing(true);
    try {
      const text = await transcribe(file, "zh");
      if (!text) toast("error", t("ASR 没有识别出内容；请人工填写逐字稿。"));
      setNewText(text);
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setTranscribing(false);
    }
  };

  const register = async () => {
    const file = referenceFile();
    if (!newId.trim() || !newText.trim() || !file) {
      toast("error", t("注册需要：ID、参考音频（上传或录制）、参考音的逐字稿。"));
      return;
    }
    setRegistering(true);
    try {
      const registered = newId.trim();
      await registerVoice(registered, newText.trim(), file);
      toast("info", t("已注册 {id} —— 见音色库首位，可试听或直接用于生成。", { id: registered }));
      setNewId("");
      setNewText("");
      if (fileInput.current) fileInput.current.value = "";
      discardRecording();
      discardUpload();
      await refresh();
      // Surface the new voice immediately: filter the bank to it.
      setCategory("全部");
      setQuery(registered);
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setRegistering(false);
    }
  };

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const voice of voicesList) {
      const key = categoryOf(voice.id);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // The user's own voices lead; preset categories follow by size.
    return [...counts.entries()].sort((a, b) =>
      a[0] === ownCategory ? -1 : b[0] === ownCategory ? 1 : b[1] - a[1]);
  }, [voicesList]);

  const multiEngine = new Set(voicesList.map(voice => voice.engine)).size > 1;
  const filtered = voicesList
    .filter(voice =>
      (category === "全部" || categoryOf(voice.id) === category)
      && (query === "" || voice.id.toLowerCase().includes(query.toLowerCase())
        || voice.engine.toLowerCase().includes(query.toLowerCase())))
    // Own voices sort first in the "全部" view too — not buried under 100+ presets.
    .sort((a, b) => Number(categoryOf(b.id) === ownCategory) - Number(categoryOf(a.id) === ownCategory));

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 md:px-8 md:py-10">
      <h1 className="text-2xl font-semibold">{t("音色")}</h1>

      <section className="rounded-xl border border-ink-700 bg-ink-900 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="text-sm font-medium text-ink-300">
            {t("音色库")} <span className="text-ink-500">{filtered.length}/{voicesList.length}</span>
          </h2>
          <div className="flex-1" />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t("搜索…")}
            className="w-32 rounded border border-ink-700 bg-ink-800 px-2 py-1 text-xs text-ink-100 placeholder:text-ink-500"
          />
          <button
            onClick={() => setShowRegister(value => !value)}
            className={`rounded-lg border px-3 py-1 text-xs ${
              showRegister ? "border-accent-500/60 text-accent-500" : "border-ink-700 text-ink-300 hover:text-ink-100"
            }`}
          >
            {showRegister ? t("收起注册") : t("＋ 注册音色")}
          </button>
        </div>
        {categories.length > 1 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {(["全部", ...categories.map(([name]) => name)] as MessageKey[]).map(name => (
              <button
                key={name}
                onClick={() => setCategory(name)}
                className={`rounded-full px-2.5 py-0.5 text-[11px] ${
                  category === name ? "bg-accent-600/25 text-accent-500" : "bg-ink-800 text-ink-300 hover:text-ink-100"
                }`}
              >
                {t(name)}
                {name !== "全部" && (
                  <span className="ml-1 opacity-60">{categories.find(([label]) => label === name)?.[1]}</span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 max-h-[45vh] overflow-y-auto pr-1">
          {voicesList.length === 0 && <p className="text-sm text-ink-500">{t("引擎没有返回音色；克隆型引擎可用下方表单注册。")}</p>}
          {voicesList.length > 0 && filtered.length === 0 && <p className="text-sm text-ink-500">{t("没有匹配的音色。")}</p>}
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
            {filtered.map(voice => (
              <div
                key={`${voice.engine}/${voice.id}`}
                className="group flex items-center gap-1 rounded-lg border border-ink-700/60 bg-ink-800/60 px-2 py-1.5 text-xs"
              >
                <button
                  onClick={() => void audition(voice.id, voice.engine)}
                  disabled={auditioning === voice.id}
                  className={`min-w-0 flex-1 truncate text-left hover:text-accent-500 disabled:opacity-40 ${
                    playing === voice.id ? "text-accent-500" : "text-ink-100"
                  }`}
                  title={playing === voice.id ? t("停止") : t("试听 {id}（{engine}）", { id: voice.id, engine: voice.engine })}
                >
                  {auditioning === voice.id ? t("▶ 合成中…") : playing === voice.id ? `■ ${voice.id}` : voice.id}
                </button>
                {confirmDelete === `${voice.engine}/${voice.id}` ? (
                  <>
                    <button
                      onClick={() => {
                        setConfirmDelete("");
                        void remove(voice.id, voice.engine);
                      }}
                      className="shrink-0 rounded bg-red-500/20 px-2 py-1 text-red-300 hover:bg-red-500/30"
                    >
                      {t("删除")}
                    </button>
                    <button
                      onClick={() => setConfirmDelete("")}
                      className="shrink-0 rounded px-2 py-1 text-ink-500 hover:text-ink-300"
                    >
                      {t("取消")}
                    </button>
                  </>
                ) : (
                  <>
                    {multiEngine && voice.engine && (
                      <span className="shrink-0 rounded bg-ink-700/80 px-1 text-[10px] text-ink-300">{voice.engine}</span>
                    )}
                    <button
                      onClick={() => {
                        setGenerateVoice(voice.id, voice.engine);
                        toast("info", t("已将 {id} 设为「生成」页的音色", { id: voice.id }));
                      }}
                      className="shrink-0 rounded px-1.5 py-1 text-ink-500 hover:text-accent-500"
                      title={t("设为生成音色")}
                    >
                      {t("用")}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(`${voice.engine}/${voice.id}`)}
                      className="shrink-0 rounded px-1.5 py-1 text-ink-500 hover:text-red-300"
                      title={t("删除（引擎侧参考音一并删除）")}
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
        <p className="mt-2 text-[11px] text-ink-500">{t("点音色名试听；「用」发送到生成页。")}</p>
        {showRegister && (
          <div className="mt-3 rounded-lg border border-ink-700/60 bg-ink-800/40 p-3">
            <p className="text-[11px] text-ink-500">
              {t("注册到克隆型引擎：5–15 秒干净参考音（上传或现场录制）+ 与音频逐字对应的文本；逐字稿可先用 ASR 识别再修正。")}
            </p>
            <div className="mt-2 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <input
              value={newId}
              onChange={event => setNewId(event.target.value)}
              placeholder={t("音色 ID（字母数字._-）")}
              className="w-44 rounded border border-ink-700 bg-ink-800 px-2 py-1.5 text-xs text-ink-100"
            />
            <div className="flex overflow-hidden rounded-lg border border-ink-700 text-xs">
              {(["upload", "record"] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setSource(mode)}
                  className={`px-3 py-1.5 ${source === mode ? "bg-ink-700 text-ink-100" : "text-ink-300 hover:text-ink-100"}`}
                >
                  {mode === "upload" ? t("上传文件") : t("现场录制")}
                </button>
              ))}
            </div>
          </div>

          {source === "upload" ? (
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={fileInput}
                type="file"
                accept="audio/*"
                onChange={event => {
                  // A wrong file should be audible now, not after registration.
                  discardUpload();
                  const file = event.target.files?.[0];
                  if (file) setUploaded({ url: URL.createObjectURL(file), name: file.name });
                }}
                className="text-xs text-ink-300 file:mr-2 file:rounded file:border-0 file:bg-ink-700 file:px-2 file:py-1.5 file:text-xs file:text-ink-100"
              />
              {uploaded && <audio controls src={uploaded.url} className="h-9 max-w-64" />}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              {recorder ? (
                <button
                  onClick={() => void stopRecording(recorder)}
                  className="flex items-center gap-2 rounded-lg bg-red-500/90 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
                >
                  <span className="inline-block size-2 animate-pulse rounded-full bg-white" />
                  {t("停止（{elapsed}s / 30s）", { elapsed: (elapsedMs / 1_000).toFixed(1) })}
                </button>
              ) : (
                <button
                  onClick={() => void startRecording()}
                  className="rounded-lg border border-ink-700 px-4 py-2 text-sm text-ink-100 hover:bg-ink-800"
                >
                  {recorded ? t("重新录制") : `🎙 ${t("开始录制")}`}
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
              placeholder={t("参考音的逐字稿…")}
              className="w-full flex-1 rounded border border-ink-700 bg-ink-800 px-2 py-1.5 text-xs text-ink-100"
            />
            <button
              onClick={() => void fillTranscript()}
              disabled={transcribing}
              className="shrink-0 rounded border border-ink-700 px-2 py-1.5 text-[11px] text-ink-300 hover:text-ink-100 disabled:opacity-40"
              title={t("用 ASR 识别参考音，生成逐字稿草稿")}
            >
              {transcribing ? t("识别中…") : t("ASR 识别")}
            </button>
          </div>
          <div>
            <button
              onClick={() => void register()}
              disabled={registering || recorder !== undefined}
              className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white hover:bg-accent-500 disabled:opacity-40"
            >
              {registering ? t("注册中…") : t("注册")}
            </button>
          </div>
        </div>
          </div>
        )}

      </section>

      <ProfilesSection
        profiles={voicesList.filter(voice => voice.designProfile !== undefined)}
        onChanged={() => void refresh()}
        onAudition={(id, engine) => void audition(id, engine)}
        auditioning={auditioning}
        playing={playing}
      />
    </div>
  );
}

/** Fingerprint short form: enough to eyeball identity, click-to-copy for the rest. */
function Fingerprint({ sha }: { sha: string | undefined }) {
  const t = useT();
  if (!sha) return <span className="text-ink-500">{t("无指纹")}</span>;
  return (
    <button
      onClick={() => void navigator.clipboard?.writeText(sha)}
      title={`${sha}${t("（点击复制）")}`}
      className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-300 hover:text-accent-500"
    >
      {sha.slice(0, 8)}
    </button>
  );
}

function ProfilesSection({ profiles, onChanged, onAudition, auditioning, playing }: {
  profiles: VoiceEntry[];
  onChanged: () => void;
  onAudition: (id: string, engine: string) => void;
  auditioning: string;
  playing: string;
}) {
  const t = useT();
  const [engines, setEngines] = useState<EngineEntry[]>([]);
  const toast = useStudio(state => state.toast);
  const [verifying, setVerifying] = useState("");
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ id: "", description: "", anchorText: "这是一段用于固定音色的锚文本。", seed: "20260715", cfg: "2", timesteps: "10" });

  useEffect(() => {
    listEngines().then(setEngines).catch(() => {});
  }, []);

  // Audit: the profile's recorded model identity vs the owning engine's live identity.
  const auditOf = (profile: VoiceEntry): { label: string; tone: string; title: string } => {
    const meta = profile.designProfile;
    const runtime = engines.find(entry => entry.name === profile.engine)?.runtime;
    if (!meta || !runtime) return { label: t("未知"), tone: "bg-ink-700 text-ink-300", title: t("引擎身份不可达") };
    if (meta.model !== runtime.model) {
      return {
        label: t("模型漂移"),
        tone: "bg-red-500/20 text-red-300",
        title: t("档案 {profile} ≠ 运行时 {runtime}", { profile: meta.model, runtime: runtime.model }),
      };
    }
    if ((meta.model_manifest_sha256 ?? null) !== runtime.manifestSha256) {
      return { label: t("清单漂移"), tone: "bg-amber-500/20 text-amber-300", title: t("模型清单指纹与运行时不一致") };
    }
    return { label: t("与运行时一致"), tone: "bg-emerald-500/20 text-emerald-300", title: t("模型与清单指纹均一致") };
  };

  // Verify = reproduce under a throwaway id, compare the audio fingerprint, clean up.
  const verify = async (profile: VoiceEntry) => {
    const meta = profile.designProfile;
    if (!meta || !profile.promptText) {
      toast("error", t("{id} 缺少锚文本或指纹，无法验证。", { id: profile.id }));
      return;
    }
    setVerifying(profile.id);
    toast("info", t("正在重现 {id}（同参数重新生成并比对指纹）…", { id: profile.id }));
    const probe = `${profile.id}-vfy-${Date.now().toString(36)}`;
    try {
      const copy = await createDesignProfile({
        id: probe,
        description: meta.description,
        anchorText: profile.promptText,
        seed: meta.seed,
        cfgValue: meta.cfg_value,
        timesteps: meta.timesteps,
      }, profile.engine || undefined);
      const match = copy.designProfile?.audio_sha256 !== undefined
        && copy.designProfile.audio_sha256 === meta.audio_sha256;
      if (match) toast("info", t("✓ {id} 可逐字节重现（指纹一致）", { id: profile.id }));
      else toast("error", t("✗ {id} 重现结果指纹不一致 —— 运行时已漂移或参数缺失", { id: profile.id }));
      await deleteVoice(probe, profile.engine || undefined).catch(() => {});
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setVerifying("");
    }
  };

  const create = async () => {
    const seed = Number(form.seed);
    if (!form.id.trim() || !form.description.trim() || !form.anchorText.trim() || !Number.isInteger(seed)) {
      toast("error", t("创建需要：ID、英文声音描述、锚文本、整数 seed。"));
      return;
    }
    setCreating(true);
    toast("info", t("生成锚音频并登记指纹…"));
    try {
      await createDesignProfile({
        id: form.id.trim(),
        description: form.description.trim(),
        anchorText: form.anchorText.trim(),
        seed,
        cfgValue: Number(form.cfg) || 2,
        timesteps: Number(form.timesteps) || 10,
      });
      toast("info", t("已创建设计档 {id}", { id: form.id.trim() }));
      setForm({ ...form, id: "", description: "" });
      setShowForm(false);
      onChanged();
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="rounded-xl border border-ink-700 bg-ink-900 p-4 md:p-5">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium text-ink-300">{t("设计档（{n}）", { n: profiles.length })}</h2>
        <div className="flex-1" />
        <button
          onClick={() => setShowForm(value => !value)}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100"
        >
          {showForm ? t("收起") : t("新建设计档")}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-ink-500">
        {t("零样本声音设计：描述 + 锚文本 + seed 固定一个可复现的音色；指纹（SHA-256）保证同一运行时可逐字节重现。")}
      </p>

      {showForm && (
        <div className="mt-3 flex flex-col gap-2 rounded-lg border border-ink-700/60 bg-ink-800/40 p-3">
          <div className="flex flex-wrap gap-2">
            <input value={form.id} onChange={event => setForm({ ...form, id: event.target.value })} placeholder={t("设计档 ID")}
              className="w-40 rounded border border-ink-700 bg-ink-800 px-2 py-1.5 text-xs text-ink-100" />
            <input value={form.description} onChange={event => setForm({ ...form, description: event.target.value })}
              placeholder={t("声音描述（英文，如 calm clear female voice）")}
              className="min-w-64 flex-1 rounded border border-ink-700 bg-ink-800 px-2 py-1.5 text-xs text-ink-100" />
          </div>
          <textarea value={form.anchorText} onChange={event => setForm({ ...form, anchorText: event.target.value })}
            rows={2} placeholder={t("锚文本（将被固定为该音色的参考语料）")}
            className="w-full rounded border border-ink-700 bg-ink-800 px-2 py-1.5 text-xs text-ink-100" />
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-300">
            <label className="flex items-center gap-1">seed
              <input value={form.seed} onChange={event => setForm({ ...form, seed: event.target.value })}
                className="w-24 rounded border border-ink-700 bg-ink-800 px-2 py-1 text-xs text-ink-100" />
            </label>
            <label className="flex items-center gap-1">cfg
              <input value={form.cfg} onChange={event => setForm({ ...form, cfg: event.target.value })}
                className="w-14 rounded border border-ink-700 bg-ink-800 px-2 py-1 text-xs text-ink-100" />
            </label>
            <label className="flex items-center gap-1">timesteps
              <input value={form.timesteps} onChange={event => setForm({ ...form, timesteps: event.target.value })}
                className="w-14 rounded border border-ink-700 bg-ink-800 px-2 py-1 text-xs text-ink-100" />
            </label>
            <div className="flex-1" />
            <button onClick={() => void create()} disabled={creating}
              className="rounded-lg bg-accent-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-500 disabled:opacity-40">
              {creating ? t("生成中…") : t("创建")}
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 space-y-2">
        {profiles.length === 0 && (
          <p className="text-sm text-ink-500">{t("还没有设计档；需要具备 design 能力的引擎（见设置页注册表）。")}</p>
        )}
        {profiles.map(profile => {
          const meta = profile.designProfile;
          const auditState = auditOf(profile);
          return (
            <div key={`${profile.engine}/${profile.id}`} className="rounded-lg border border-ink-700/60 bg-ink-800/40 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{profile.id}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] ${auditState.tone}`} title={auditState.title}>
                  {auditState.label}
                </span>
                <Fingerprint sha={meta?.audio_sha256} />
                {profile.engine && <span className="rounded bg-ink-700/80 px-1.5 py-0.5 text-[10px] text-ink-300">{profile.engine}</span>}
                <div className="flex-1" />
                <button onClick={() => onAudition(profile.id, profile.engine)} disabled={auditioning === profile.id}
                  className="rounded border border-ink-700 px-2 py-1 text-[11px] text-ink-300 hover:text-ink-100 disabled:opacity-40">
                  {auditioning === profile.id ? t("合成中…") : playing === profile.id ? t("■ 停止") : t("试听")}
                </button>
                <button onClick={() => void verify(profile)} disabled={verifying !== ""}
                  title={t("同参数重新生成一次并比对音频指纹（可逐字节重现性检验）")}
                  className="rounded border border-ink-700 px-2 py-1 text-[11px] text-ink-300 hover:text-ink-100 disabled:opacity-40">
                  {verifying === profile.id ? t("验证中…") : t("验证")}
                </button>
              </div>
              <p className="mt-1 truncate text-[11px] text-ink-500" title={`${meta?.description ?? ""} · ${meta?.model ?? ""}`}>
                {meta?.description} <span className="text-ink-500/70">· seed {meta?.seed} · cfg {meta?.cfg_value} · timesteps {meta?.timesteps}{meta?.model ? ` · ${meta.model}` : ""}</span>
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
