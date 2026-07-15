import { useEffect, useRef, useState } from "react";
import { deleteVoice, listVoices, registerVoice, synthesize } from "../lib/api";
import { useStudio } from "../store";

const auditionText = "你好，这是一段试听。今天天气不错。";

export function VoicesPanel() {
  const voicesList = useStudio(state => state.voicesList);
  const setVoicesList = useStudio(state => state.setVoicesList);
  const [status, setStatus] = useState<{ kind: "info" | "error"; text: string } | undefined>(undefined);
  const [auditioning, setAuditioning] = useState("");
  const [registering, setRegistering] = useState(false);
  const [newId, setNewId] = useState("");
  const [newText, setNewText] = useState("");
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

  const register = async () => {
    const file = fileInput.current?.files?.[0];
    if (!newId.trim() || !newText.trim() || !file) {
      setStatus({ kind: "error", text: "注册需要：ID、参考音频文件、参考音的逐字稿。" });
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
        <p className="mt-1 text-[11px] text-ink-500">上传 5–15 秒干净的参考音频，并给出与音频逐字对应的文本。</p>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <input
              value={newId}
              onChange={event => setNewId(event.target.value)}
              placeholder="音色 ID（字母数字._-）"
              className="w-48 rounded border border-ink-700 bg-ink-800 px-2 py-1.5 text-xs text-ink-100"
            />
            <input ref={fileInput} type="file" accept="audio/*" className="text-xs text-ink-300 file:mr-2 file:rounded file:border-0 file:bg-ink-700 file:px-2 file:py-1.5 file:text-xs file:text-ink-100" />
          </div>
          <textarea
            value={newText}
            onChange={event => setNewText(event.target.value)}
            rows={2}
            placeholder="参考音的逐字稿…"
            className="w-full rounded border border-ink-700 bg-ink-800 px-2 py-1.5 text-xs text-ink-100"
          />
          <div>
            <button
              onClick={() => void register()}
              disabled={registering}
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
