import { useEffect, useMemo, useState } from "react";
import { listEngines, type EngineEntry } from "../lib/api";
import { useStudio } from "../store";
import { useT } from "../i18n";

type EngineKind = "asr" | "llm" | "tts";

const kindLabels = {
  asr: "语音识别 ASR",
  llm: "语言模型 LLM",
  tts: "语音合成 TTS",
} as const satisfies Record<EngineKind, string>;

function defaultFor(engines: EngineEntry[], kind: EngineKind): string {
  return engines.find(entry => entry.roles.includes(kind))?.name ?? "";
}

function EngineSelect({ kind, value, engines, onChange }: {
  kind: EngineKind;
  value: string;
  engines: EngineEntry[];
  onChange: (value: string) => void;
}) {
  const t = useT();
  const candidates = engines.filter(entry => entry.kind === kind);
  const roleDefault = defaultFor(engines, kind);
  return (
    <label className="grid gap-1.5">
      <span className="text-[11px] font-medium text-ink-400">{t(kindLabels[kind])}</span>
      <select
        value={value}
        onChange={event => onChange(event.target.value)}
        className="w-full rounded-lg border border-ink-700 bg-ink-800 px-2.5 py-2 text-xs text-ink-100"
      >
        <option value="">{t("自动（{engine}）", { engine: roleDefault || t("未配置") })}</option>
        {candidates.map(entry => (
          <option key={entry.name} value={entry.name}>
            {entry.healthy ? "●" : "○"} {entry.name}{entry.model ? ` · ${entry.model}` : ""}
          </option>
        ))}
      </select>
      {value && (
        <span className="text-[10px] text-ink-500">
          {engines.find(entry => entry.name === value)?.capabilities.join(" · ") || t("显式选择")}
        </span>
      )}
    </label>
  );
}

export function ConversationRoutePicker() {
  const t = useT();
  const engines = useStudio(state => state.enginesList);
  const setEngines = useStudio(state => state.setEnginesList);
  const asr = useStudio(state => state.conversationAsrEngine);
  const llm = useStudio(state => state.conversationLlmEngine);
  const tts = useStudio(state => state.conversationTtsEngine);
  const setEngine = useStudio(state => state.setConversationEngine);
  const reset = useStudio(state => state.resetConversationEngines);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (engines.length === 0) listEngines().then(setEngines).catch(() => {});
  }, [engines.length, setEngines]);

  const summary = useMemo(() => {
    const selected = [asr, llm, tts].filter(Boolean);
    return selected.length === 0 ? t("自动") : selected.join(" · ");
  }, [asr, llm, tts, t]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className="max-w-64 truncate rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100"
        title={summary}
      >
        ⚙ {t("运行路线")}：{summary} ▾
      </button>
      {open && (
        <div className="absolute left-1/2 z-30 mt-2 w-80 -translate-x-1/2 space-y-3 rounded-xl border border-ink-700 bg-ink-900 p-4 text-left shadow-2xl">
          <div>
            <div className="text-sm font-medium">{t("运行路线")}</div>
            <div className="mt-0.5 text-[11px] text-ink-500">{t("留在自动即可使用网关默认引擎。")}</div>
          </div>
          <EngineSelect kind="asr" value={asr} engines={engines} onChange={value => setEngine("asr", value)} />
          <EngineSelect kind="llm" value={llm} engines={engines} onChange={value => setEngine("llm", value)} />
          <EngineSelect kind="tts" value={tts} engines={engines} onChange={value => setEngine("tts", value)} />
          <div className="flex items-center justify-between border-t border-ink-700 pt-3">
            <button type="button" onClick={reset} className="text-xs text-ink-400 hover:text-ink-100">
              {t("恢复全部自动")}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded bg-ink-700 px-3 py-1 text-xs">
              {t("完成")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function TtsEnginePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const engines = useStudio(state => state.enginesList);
  const setEngines = useStudio(state => state.setEnginesList);
  useEffect(() => {
    if (engines.length === 0) listEngines().then(setEngines).catch(() => {});
  }, [engines.length, setEngines]);
  return (
    <div className="min-w-48">
      <EngineSelect kind="tts" value={value} engines={engines} onChange={onChange} />
    </div>
  );
}
