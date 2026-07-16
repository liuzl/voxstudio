import { estSeconds, chunkText } from "@voxstudio/text";
import { useEffect, useMemo, useRef, useState } from "react";
import { listVoices, synthesize } from "../lib/api";
import { useStudio } from "../store";

/** Ticks once a second while a synthesis runs — long texts deserve a visible clock. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return <>{Math.max(0, Math.round((now - since) / 1_000))}s</>;
}

function VoicePicker({ value, engine, onChange }: {
  value: string;
  engine: string;
  onChange: (voice: string, engine?: string) => void;
}) {
  const voicesList = useStudio(state => state.voicesList);
  const byEngine = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const entry of voicesList) {
      groups.set(entry.engine, [...(groups.get(entry.engine) ?? []), entry.id]);
    }
    return [...groups.entries()];
  }, [voicesList]);
  return (
    <label className="flex items-center gap-2 text-xs text-ink-300">
      音色
      <select
        value={value ? `${engine}::${value}` : ""}
        onChange={event => {
          const [nextEngine, id] = event.target.value.split("::");
          // Picking a voice carries its owning engine; 默认 falls to the role default.
          onChange(id ?? "", nextEngine || undefined);
        }}
        className="max-w-48 rounded border border-ink-700 bg-ink-800 px-2 py-1.5 text-xs text-ink-100"
      >
        <option value="">默认（{byEngine[0]?.[0] || "引擎默认"}）</option>
        {byEngine.map(([groupEngine, ids]) => (
          <optgroup key={groupEngine} label={groupEngine}>
            {ids.map(id => (
              <option key={`${groupEngine}::${id}`} value={`${groupEngine}::${id}`}>
                {id}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

export function GeneratePanel() {
  const [text, setText] = useState("");
  const voice = useStudio(state => state.generateVoice);
  const engine = useStudio(state => state.generateEngine);
  const setVoice = useStudio(state => state.setGenerateVoice);
  const [busy, setBusy] = useState(false);
  const [busySince, setBusySince] = useState(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const toast = useStudio(state => state.toast);
  const takes = useStudio(state => state.takes);
  const addTake = useStudio(state => state.addTake);
  const removeTake = useStudio(state => state.removeTake);
  const setVoicesList = useStudio(state => state.setVoicesList);

  useEffect(() => {
    listVoices().then(setVoicesList).catch(() => {});
  }, [setVoicesList]);

  const seconds = text.trim() ? Math.round(estSeconds(text)) : 0;
  const chunks = text.trim() ? chunkText(text).length : 0;

  const generate = async () => {
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setBusySince(Date.now());
    try {
      const url = await synthesize({ input: text.trim(), voice, ...(engine ? { engine } : {}), signal: controller.signal });
      addTake({
        id: crypto.randomUUID(),
        text: text.trim(),
        voice: `${voice || "默认"}${engine ? ` @${engine}` : ""}`,
        at: Date.now(),
        url,
      });
    } catch (failure) {
      if (controller.signal.aborted) {
        toast("info", "已取消合成");
      } else {
        toast("error", failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      abort.current = undefined;
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-8 md:py-10">
      <h1 className="text-2xl font-semibold">生成</h1>

      <section className="space-y-3 rounded-xl border border-ink-700 bg-ink-900 p-4 md:p-5">
        <textarea
          value={text}
          onChange={event => setText(event.target.value)}
          rows={5}
          placeholder="输入要合成的文本…"
          className="w-full resize-y rounded-lg border border-ink-700 bg-ink-800 px-3 py-2.5 text-sm leading-relaxed text-ink-100 placeholder:text-ink-500"
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <VoicePicker value={voice} engine={engine} onChange={setVoice} />
          {text.trim() && (
            <span className="text-[11px] text-ink-500">
              预计 {seconds}s{chunks > 1 ? ` · 长文将按 ${chunks} 块合成（CLI 长文管线）` : ""}
            </span>
          )}
          <div className="flex-1" />
          {busy && (
            <button
              onClick={() => abort.current?.abort()}
              className="rounded-lg border border-ink-700 px-4 py-2 text-sm text-ink-300 hover:text-ink-100"
            >
              取消
            </button>
          )}
          <button
            onClick={() => void generate()}
            disabled={busy || !text.trim()}
            className="rounded-lg bg-accent-600 px-5 py-2 text-sm font-medium text-white hover:bg-accent-500 disabled:opacity-40"
          >
            {busy ? <>合成中… <Elapsed since={busySince} /></> : "生成"}
          </button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-ink-300">Takes（本页会话内保留，最近 30 条）</h2>
        {takes.length === 0 && <p className="text-sm text-ink-500">还没有生成记录。</p>}
        {takes.map(take => (
          <div key={take.id} className="rounded-xl border border-ink-700 bg-ink-900 p-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{take.text}</p>
                <p className="mt-1 text-[11px] text-ink-500">
                  {take.voice} · {new Date(take.at).toLocaleTimeString()}
                </p>
              </div>
              <a
                href={take.url}
                download={`take-${new Date(take.at).toISOString().replace(/[:.]/g, "-")}.wav`}
                className="shrink-0 rounded border border-ink-700 px-2 py-1 text-[11px] text-ink-300 hover:text-ink-100"
              >
                下载
              </a>
              <button
                onClick={() => removeTake(take.id)}
                className="shrink-0 rounded border border-ink-700 px-2 py-1 text-[11px] text-ink-300 hover:text-red-300"
              >
                删除
              </button>
            </div>
            <audio controls src={take.url} className="mt-3 h-9 w-full" />
          </div>
        ))}
      </section>
    </div>
  );
}
