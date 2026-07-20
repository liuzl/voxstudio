import { useCallback, useEffect, useState } from "react";
import {
  captureAudioUrl,
  correctCapture,
  deleteCapture,
  listCaptures,
  promoteCapture,
  transcribe,
  type CaptureEntry,
} from "../lib/api";
import { useStudio } from "../store";
import { useT } from "../i18n";

const pageSize = 50;

/** "lib-" + timestamp: a promote suggestion the user can always overtype. */
function suggestVoiceId(): string {
  return `lib-${new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "")}`;
}

function formatWhen(at: number): string {
  const date = new Date(at);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

/** Binary units, matching the gateway's K/M/G quota flag. */
function formatBytes(count: number): string {
  let value = count;
  let unit = "B";
  for (const next of ["KB", "MB", "GB"]) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${unit === "B" || value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

/**
 * 素材库 (docs/web-studio.md Phase 4): every retained utterance with its raw ASR text,
 * playable in place; a correction editor that writes the human reference (the ASR
 * reference workflow's .ref.txt); one-click promotion to a clone voice sample.
 */
export function LibraryPanel() {
  const t = useT();
  const toast = useStudio(state => state.toast);
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [captures, setCaptures] = useState<CaptureEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState("");
  const [promotingId, setPromotingId] = useState("");
  const [voiceId, setVoiceId] = useState("");

  const report = useCallback((failure: unknown) => {
    toast("error", failure instanceof Error ? failure.message : String(failure));
  }, [toast]);

  const refresh = useCallback(async () => {
    try {
      const page = await listCaptures(pageSize, 0);
      setEnabled(page.enabled);
      setCaptures(page.captures);
      setTotal(page.total);
      setBytes(page.bytes);
      setMaxBytes(page.maxBytes);
    } catch (failure) {
      report(failure);
    }
  }, [report]);

  useEffect(() => { void refresh(); }, [refresh]);

  const loadMore = async () => {
    try {
      const page = await listCaptures(pageSize, captures.length);
      setCaptures(current => [...current, ...page.captures]);
      setTotal(page.total);
      setBytes(page.bytes);
      setMaxBytes(page.maxBytes);
    } catch (failure) {
      report(failure);
    }
  };

  const replace = (updated: CaptureEntry): void => {
    setCaptures(current => current.map(entry => entry.id === updated.id ? updated : entry));
  };

  const openEditor = (capture: CaptureEntry): void => {
    setPromotingId("");
    setEditingId(capture.id);
    setDraft(capture.corrected ?? capture.transcript);
  };

  const saveCorrection = async (capture: CaptureEntry, text: string) => {
    setBusy(capture.id);
    try {
      replace(await correctCapture(capture.id, text));
      setEditingId("");
      toast("info", text.trim() === "" ? t("已清除校正") : t("已保存校正"));
    } catch (failure) {
      report(failure);
    } finally {
      setBusy("");
    }
  };

  // Re-transcribe through the facade and prefill the editor — the raw capture text is
  // history, not a draft; only a human save touches the reference.
  const retranscribe = async (capture: CaptureEntry) => {
    setBusy(capture.id);
    try {
      const audio = await (await fetch(captureAudioUrl(capture.id))).blob();
      const text = await transcribe(new File([audio], `${capture.id}.wav`, { type: "audio/wav" }));
      setPromotingId("");
      setEditingId(capture.id);
      setDraft(text);
    } catch (failure) {
      report(failure);
    } finally {
      setBusy("");
    }
  };

  const promote = async (capture: CaptureEntry) => {
    const id = voiceId.trim();
    if (!id) return;
    setBusy(capture.id);
    try {
      replace(await promoteCapture(capture.id, id));
      setPromotingId("");
      toast("info", t("已注册为音色 {id}", { id }));
    } catch (failure) {
      report(failure);
    } finally {
      setBusy("");
    }
  };

  const remove = async (capture: CaptureEntry) => {
    setBusy(capture.id);
    try {
      await deleteCapture(capture.id);
      setCaptures(current => current.filter(entry => entry.id !== capture.id));
      setTotal(current => Math.max(0, current - 1));
    } catch (failure) {
      report(failure);
      setBusy("");
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-8 md:py-10">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">{t("素材库")}</h1>
        {enabled === true && (
          <span className="text-xs text-ink-500">
            {t("共 {n} 条", { n: total })}
            {maxBytes !== null && ` · ${t("已用 {used} / {max}", { used: formatBytes(bytes), max: formatBytes(maxBytes) })}`}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => void refresh()}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100"
        >
          {t("刷新")}
        </button>
      </div>

      {enabled === false && (
        <section className="rounded-xl border border-ink-700 bg-ink-900 p-5 text-sm leading-relaxed text-ink-300">
          <p>{t("素材库未启用。以 --library 目录 启动网关（vox studio --library DIR）后，对话中的每句话会连同转写自动归档到这里——留存是显式的部署决定。")}</p>
        </section>
      )}

      {enabled === true && captures.length === 0 && (
        <p className="text-sm text-ink-500">{t("还没有素材。开始一段对话，你说的每句话会自动出现在这里。")}</p>
      )}

      {captures.map(capture => {
        const editing = editingId === capture.id;
        const promoting = promotingId === capture.id;
        const rowBusy = busy === capture.id;
        return (
          <div key={capture.id} className="rounded-xl border border-ink-700 bg-ink-900 p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-500">
              <span>{formatWhen(capture.createdAt)}</span>
              <span>{(capture.durationMs / 1_000).toFixed(1)}s</span>
              <span title={capture.sessionId}>{t("会话 {id}", { id: capture.sessionId.slice(0, 8) })}</span>
              {capture.promotedVoiceId && (
                <span className="rounded border border-emerald-400/40 px-1.5 py-0.5 text-emerald-300">
                  {t("已注册音色")} {capture.promotedVoiceId}
                </span>
              )}
            </div>

            <div className="mt-2 space-y-1 text-sm">
              <p className={capture.corrected === null ? "" : "text-ink-500 line-through decoration-ink-600"}>
                {capture.transcript === "" ? <span className="italic text-ink-500">{t("（识别为空）")}</span> : capture.transcript}
              </p>
              {capture.corrected !== null && <p>{capture.corrected}</p>}
            </div>

            <audio controls preload="none" src={captureAudioUrl(capture.id)} className="mt-3 h-9 w-full" />

            {editing && (
              <div className="mt-3 space-y-2">
                <textarea
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  rows={2}
                  className="w-full resize-y rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-sm leading-relaxed text-ink-100"
                  placeholder={t("听音频，把这句话的正确文本写在这里")}
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => void saveCorrection(capture, draft)}
                    disabled={rowBusy}
                    className="rounded-lg bg-accent-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-500 disabled:opacity-40"
                  >
                    {t("保存校正")}
                  </button>
                  {capture.corrected !== null && (
                    <button
                      onClick={() => void saveCorrection(capture, "")}
                      disabled={rowBusy}
                      className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100 disabled:opacity-40"
                    >
                      {t("清除校正")}
                    </button>
                  )}
                  <button
                    onClick={() => setEditingId("")}
                    className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100"
                  >
                    {t("取消")}
                  </button>
                </div>
              </div>
            )}

            {promoting && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  value={voiceId}
                  onChange={event => setVoiceId(event.target.value)}
                  className="w-48 rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-sm text-ink-100"
                  placeholder={t("音色 ID")}
                />
                <button
                  onClick={() => void promote(capture)}
                  disabled={rowBusy || !voiceId.trim()}
                  className="rounded-lg bg-accent-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-500 disabled:opacity-40"
                >
                  {t("注册")}
                </button>
                <button
                  onClick={() => setPromotingId("")}
                  className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100"
                >
                  {t("取消")}
                </button>
                <span className="text-[11px] text-ink-500">{t("以校正后的文本作为参考逐字稿，注册到克隆引擎。")}</span>
              </div>
            )}

            {!editing && !promoting && (
              <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                <button
                  onClick={() => openEditor(capture)}
                  className="rounded border border-ink-700 px-2 py-1 text-ink-300 hover:text-ink-100"
                >
                  {t("校正")}
                </button>
                <button
                  onClick={() => void retranscribe(capture)}
                  disabled={rowBusy}
                  className="rounded border border-ink-700 px-2 py-1 text-ink-300 hover:text-ink-100 disabled:opacity-40"
                >
                  {rowBusy ? t("识别中…") : t("重转写")}
                </button>
                <button
                  onClick={() => {
                    setEditingId("");
                    setPromotingId(capture.id);
                    setVoiceId(capture.promotedVoiceId ?? suggestVoiceId());
                  }}
                  disabled={rowBusy || (capture.corrected ?? capture.transcript).trim() === ""}
                  title={(capture.corrected ?? capture.transcript).trim() === "" ? t("先校正出文本才能注册为音色") : undefined}
                  className="rounded border border-ink-700 px-2 py-1 text-ink-300 hover:text-ink-100 disabled:opacity-40"
                >
                  {t("升级为音色")}
                </button>
                <a
                  href={captureAudioUrl(capture.id)}
                  download={`${capture.id}.wav`}
                  className="rounded border border-ink-700 px-2 py-1 text-ink-300 hover:text-ink-100"
                >
                  {t("下载")}
                </a>
                <div className="flex-1" />
                <button
                  onClick={() => void remove(capture)}
                  disabled={rowBusy}
                  className="rounded border border-ink-700 px-2 py-1 text-ink-300 hover:text-red-300 disabled:opacity-40"
                >
                  {t("删除")}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {enabled === true && captures.length < total && (
        <button
          onClick={() => void loadMore()}
          className="w-full rounded-lg border border-ink-700 px-4 py-2 text-sm text-ink-300 hover:text-ink-100"
        >
          {t("加载更多（{n} 条未显示）", { n: total - captures.length })}
        </button>
      )}
    </div>
  );
}
