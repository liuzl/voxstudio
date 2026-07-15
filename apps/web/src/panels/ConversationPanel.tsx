import { useEffect, useRef, useState } from "react";
import { conversationControls, startConversation, stopConversation } from "../conversation";
import { useStudio, type TurnView } from "../store";

const stateLabels: Record<string, { text: string; tone: string }> = {
  off: { text: "未开始", tone: "bg-ink-700 text-ink-300" },
  idle: { text: "空闲", tone: "bg-ink-700 text-ink-300" },
  listening: { text: "聆听中", tone: "bg-emerald-500/20 text-emerald-300" },
  speech_started: { text: "你在说话", tone: "bg-sky-500/20 text-sky-300" },
  finalizing: { text: "断句中", tone: "bg-sky-500/20 text-sky-300" },
  thinking: { text: "思考中", tone: "bg-amber-500/20 text-amber-300" },
  speaking: { text: "回答中", tone: "bg-accent-500/20 text-accent-500" },
  reconfiguring: { text: "重配置", tone: "bg-ink-700 text-ink-300" },
  closed: { text: "已结束", tone: "bg-ink-700 text-ink-300" },
};

const timingLabels: [string, string][] = [
  ["vad_end", "断句"],
  ["asr_done", "识别"],
  ["llm_first", "首字"],
  ["tts_first_audio", "首音"],
  ["playback_first", "开播"],
];

function TimingChips({ turn }: { turn: TurnView }) {
  if (!turn.timing) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-ink-300">
      {timingLabels.map(([key, label]) => {
        const value = turn.timing?.[key];
        if (value === undefined) return null;
        return (
          <span key={key} className="rounded bg-ink-800 px-1.5 py-0.5">
            {label} +{Math.round(value)}ms
          </span>
        );
      })}
      {turn.reopens > 0 && (
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">续说 ×{turn.reopens}</span>
      )}
      {turn.falseBargeIns > 0 && (
        <span className="rounded bg-ink-800 px-1.5 py-0.5">忽略杂音 ×{turn.falseBargeIns}</span>
      )}
    </div>
  );
}

function TurnCard({ turn }: { turn: TurnView }) {
  return (
    <div className="space-y-2">
      {turn.transcript !== undefined ? (
        <div className="flex justify-end">
          <div className="max-w-[75%] rounded-2xl rounded-br-sm bg-accent-600/20 px-4 py-2.5 text-sm leading-relaxed">
            {turn.transcript}
          </div>
        </div>
      ) : turn.status === "capturing" ? (
        <div className="flex justify-end">
          <div className="rounded-2xl rounded-br-sm bg-ink-800 px-4 py-2.5 text-sm text-ink-300">…</div>
        </div>
      ) : null}
      {(turn.reply || turn.status === "thinking") && (
        <div className="flex justify-start">
          <div
            className={`max-w-[75%] rounded-2xl rounded-bl-sm bg-ink-800 px-4 py-2.5 text-sm leading-relaxed ${
              turn.status === "interrupted" ? "opacity-60" : ""
            }`}
          >
            {turn.reply || <span className="text-ink-500">思考中…</span>}
            {turn.status === "interrupted" && <span className="ml-2 text-xs text-amber-300">（被打断）</span>}
          </div>
        </div>
      )}
      <TimingChips turn={turn} />
    </div>
  );
}

export function ConversationPanel() {
  const [starting, setStarting] = useState(false);
  const active = useStudio(state => state.active);
  const muted = useStudio(state => state.muted);
  const sessionState = useStudio(state => state.sessionState);
  const turns = useStudio(state => state.turns);
  const notices = useStudio(state => state.notices);
  const capability = useStudio(state => state.capability);
  const voice = useStudio(state => state.voice);
  const language = useStudio(state => state.language);
  const notice = useStudio(state => state.notice);
  const setVoice = useStudio(state => state.setVoice);
  const setLanguage = useStudio(state => state.setLanguage);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  // No unmount cleanup on purpose: the conversation is app-scoped and survives tab
  // switches. It ends on 结束, on session.stop, or with the page.

  const start = async () => {
    setStarting(true);
    try {
      await startConversation();
    } catch (error) {
      notice("error", `启动失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    await stopConversation();
  };

  const state = stateLabels[active ? sessionState : "off"] ?? stateLabels.off as { text: string; tone: string };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-ink-700 px-6 py-3.5">
        <h1 className="text-base font-semibold">对话</h1>
        <span className={`rounded-full px-2.5 py-0.5 text-xs ${state.tone}`}>{state.text}</span>
        <div className="flex-1" />
        {!active ? (
          <>
            <label className="flex items-center gap-2 text-xs text-ink-300">
              语言
              <select
                value={language}
                onChange={event => setLanguage(event.target.value)}
                className="rounded border border-ink-700 bg-ink-800 px-2 py-1 text-xs text-ink-100"
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
                <option value="auto">自动</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-300">
              音色
              <input
                value={voice}
                onChange={event => setVoice(event.target.value)}
                placeholder="默认"
                className="w-28 rounded border border-ink-700 bg-ink-800 px-2 py-1 text-xs text-ink-100"
              />
            </label>
            <button
              onClick={() => void start()}
              disabled={starting}
              className="rounded-lg bg-accent-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-500 disabled:opacity-50"
            >
              {starting ? "启动中…" : "开始对话"}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => conversationControls()?.setMuted(!muted)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                muted ? "border-amber-400 text-amber-300" : "border-ink-700 text-ink-300 hover:text-ink-100"
              }`}
            >
              {muted ? "已静音" : "静音"}
            </button>
            <button
              onClick={() => conversationControls()?.interruptPlayback()}
              className="rounded-lg border border-ink-700 px-3 py-1.5 text-sm text-ink-300 hover:text-ink-100"
              title="停止当前回答（也可以直接开口打断）"
            >
              停止回答
            </button>
            <button
              onClick={() => void stop()}
              className="rounded-lg border border-red-400/50 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10"
            >
              结束
            </button>
          </>
        )}
      </header>

      <div ref={scroller} className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
        {turns.length === 0 && (
          <div className="mx-auto mt-16 max-w-md text-center text-sm leading-relaxed text-ink-500">
            {active
              ? "开口即说 —— 断句、识别、回答全自动；回答播放时直接说话就能打断。"
              : "点「开始对话」授权麦克风后进入全双工语音对话。浏览器自带回声消除，支持随时打断与续说合并。"}
          </div>
        )}
        {turns.map(turn => (
          <TurnCard key={turn.id} turn={turn} />
        ))}
      </div>

      <footer className="border-t border-ink-700 px-6 py-2.5">
        <div className="flex items-center gap-4 text-[11px] text-ink-500">
          {capability && (
            <span>
              AEC {capability.echoCancellation === false ? "✗" : "✓"} · NS {capability.noiseSuppression === false ? "✗" : "✓"} · AGC{" "}
              {capability.autoGainControl === false ? "✗" : "✓"} · {capability.contextSampleRate}Hz
            </span>
          )}
          {notices.length > 0 && (
            <span className={(notices[notices.length - 1] as { kind: string }).kind === "error" ? "text-red-300" : ""}>
              {(notices[notices.length - 1] as { text: string }).text}
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}
