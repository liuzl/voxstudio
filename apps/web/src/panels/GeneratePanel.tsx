import { estSeconds, chunkText } from "@voxstudio/text";
import { Clock3, Download, FileAudio2, Sparkles, Trash2, WandSparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { VoicePicker } from "../components/VoicePicker";
import { TtsEnginePicker } from "../components/EngineRoutePicker";
import {
  PageHeader,
  PageShell,
  SectionCard,
  StatusBadge,
  primaryButton,
  secondaryButton,
} from "../components/StudioPage";
import { synthesize } from "../lib/api";
import { useStudio } from "../store";
import { useT } from "../i18n";

/** Ticks once a second while a synthesis runs — long texts deserve a visible clock. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return <>{Math.max(0, Math.round((now - since) / 1_000))}s</>;
}

export function GeneratePanel() {
  const t = useT();
  const [text, setText] = useState("");
  const voice = useStudio(state => state.generateVoice);
  const engine = useStudio(state => state.generateEngine);
  const setVoice = useStudio(state => state.setGenerateVoice);
  const setEngine = useStudio(state => state.setGenerateEngine);
  const [busy, setBusy] = useState(false);
  const [busySince, setBusySince] = useState(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const toast = useStudio(state => state.toast);
  const takes = useStudio(state => state.takes);
  const addTake = useStudio(state => state.addTake);
  const removeTake = useStudio(state => state.removeTake);

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
        voice: `${voice || t("默认")}${engine ? ` @${engine}` : ""}`,
        at: Date.now(),
        url,
      });
    } catch (failure) {
      if (controller.signal.aborted) {
        toast("info", t("已取消合成"));
      } else {
        toast("error", failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      abort.current = undefined;
      setBusy(false);
    }
  };

  return (
    <PageShell>
      <PageHeader
        title={t("文本转语音")}
        description={t("把文本快速转换为可试听、可下载的语音，支持自动路由和指定音色。")}
        badge={<StatusBadge>{t("本地会话")}</StatusBadge>}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <SectionCard className="overflow-hidden">
          <div className="border-b border-ink-700 px-4 py-3.5 sm:px-5">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <WandSparkles className="size-4 text-ink-500" strokeWidth={1.8} />
              {t("合成内容")}
            </div>
          </div>
          <div className="p-4 sm:p-5">
            <textarea
              value={text}
              onChange={event => setText(event.target.value)}
              onKeyDown={event => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !busy && text.trim()) {
                  event.preventDefault();
                  void generate();
                }
              }}
              rows={10}
              placeholder={t("输入要合成的文本…（⌘+Enter 生成）")}
              className="min-h-56 w-full resize-y rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-3 text-sm leading-6 text-ink-100 placeholder:text-ink-500"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
              <span>{text.trim().length} {t("字符")}</span>
              {text.trim() && (
                <>
                  <span>·</span>
                  <Clock3 className="size-3" />
                  <span>{t("预计 {seconds}s", { seconds })}</span>
                  {chunks > 1 && <span>{t(" · 长文将按 {chunks} 块合成（CLI 长文管线）", { chunks })}</span>}
                </>
              )}
            </div>
          </div>
        </SectionCard>

        <SectionCard className="h-fit overflow-hidden">
          <div className="border-b border-ink-700 px-4 py-3.5">
            <div className="text-[13px] font-medium">{t("输出设置")}</div>
            <div className="mt-0.5 text-[11px] text-ink-500">{t("选择运行路线和输出音色")}</div>
          </div>
          <div className="space-y-5 p-4">
            <div className="space-y-2">
              <div className="text-[11px] font-medium text-ink-500">{t("运行路线")}</div>
              <TtsEnginePicker value={engine} onChange={setEngine} />
            </div>
            <div className="space-y-2">
              <div className="text-[11px] font-medium text-ink-500">{t("音色")}</div>
              <VoicePicker value={voice} engine={engine} onChange={setVoice} className="w-full" />
            </div>
            <div className="border-t border-ink-700 pt-4">
              <div className="flex gap-2">
                {busy && (
                  <button onClick={() => abort.current?.abort()} className={`${secondaryButton} px-3`} aria-label={t("取消")}>
                    <X className="size-3.5" />
                  </button>
                )}
                <button
                  onClick={() => void generate()}
                  disabled={busy || !text.trim()}
                  className={`${primaryButton} flex-1`}
                >
                  <Sparkles className="size-3.5" />
                  {busy ? <>{t("合成中…")} <Elapsed since={busySince} /></> : t("生成")}
                </button>
              </div>
              <p className="mt-2 text-center text-[10px] text-ink-500">⌘ + Enter</p>
            </div>
          </div>
        </SectionCard>
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-[13px] font-medium text-ink-100">{t("生成记录")}</h2>
            <p className="mt-0.5 text-[11px] text-ink-500">{t("本页保留最近 30 条，刷新即失")}</p>
          </div>
          <div className="flex-1" />
          <StatusBadge>{takes.length}</StatusBadge>
        </div>
        {takes.length === 0 && (
          <SectionCard className="flex min-h-44 flex-col items-center justify-center p-6 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-ink-800">
              <FileAudio2 className="size-4.5 text-ink-500" />
            </span>
            <p className="mt-3 text-[13px] font-medium">{t("还没有生成记录。")}</p>
            <p className="mt-1 text-[11px] text-ink-500">{t("生成的语音会出现在这里，便于试听和下载。")}</p>
          </SectionCard>
        )}
        {takes.map(take => (
          <SectionCard key={take.id} className="p-4">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-ink-800">
                <FileAudio2 className="size-4 text-ink-500" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{take.text}</p>
                <p className="mt-1 text-[11px] text-ink-500">
                  {take.voice} · {new Date(take.at).toLocaleTimeString()}
                </p>
              </div>
              <a
                href={take.url}
                download={`take-${new Date(take.at).toISOString().replace(/[:.]/g, "-")}.wav`}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-ink-700 text-ink-500 hover:bg-ink-800 hover:text-ink-100"
                title={t("下载")}
              >
                <Download className="size-3.5" />
              </a>
              <button
                onClick={() => removeTake(take.id)}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-ink-700 text-ink-500 hover:bg-red-50 hover:text-red-600"
                title={t("删除")}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
            <audio controls src={take.url} className="mt-3 h-9 w-full" />
          </SectionCard>
        ))}
      </section>
    </PageShell>
  );
}
